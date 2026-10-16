import {
  createHmac,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import pool from "../config/database.js";
import { transaction } from "../repositories/transaction.js";
import { tenantWrite, requireTenant } from "./tenant-context.js";
import { entitlements } from "./entitlement.service.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
import { env } from "../config/env.js";
import { organizationUsage } from "./mailbox-usage.service.js";
export interface PaymentProvider {
  readonly mode: "sandbox" | "unconfigured";
  verify(raw: Buffer, signature: string): unknown;
}
export class SandboxPaymentProvider implements PaymentProvider {
  readonly mode = "sandbox" as const;
  constructor(private key: Buffer) {
    if (key.length < 32 || env.NODE_ENV === "production")
      throw new Error("Sandbox payment provider is local only");
  }
  verify(raw: Buffer, signature: string) {
    const match = /^t=(\d{10}),v1=([a-f0-9]{64})$/.exec(signature);
    if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300)
      throw new HttpError(400, "Invalid webhook signature");
    const expected = createHmac("sha256", this.key)
      .update(match[1] + ".")
      .update(raw)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2]!, "hex")))
      throw new HttpError(400, "Invalid webhook signature");
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid webhook event");
    }
  }
}

export type RenewalOutcome = "succeeded" | "failed";
export type RenewalEffect = {
  idempotencyKey: string;
  requestId: string;
  organizationId: string;
  planId: string;
  period: "monthly" | "yearly";
  amountMinor: number;
  currency: string;
};
export interface RenewalProvider {
  readonly mode: "local-synthetic" | "unconfigured";
  renew(effect: RenewalEffect, signal: AbortSignal): Promise<RenewalOutcome>;
}
export class RenewalProviderError extends Error {
  constructor(
    readonly code: "PROVIDER_UNAVAILABLE" | "OUTCOME_UNKNOWN" | "OPERATION_TIMEOUT",
  ) {
    super(code);
  }
}
export class SyntheticRenewalProvider implements RenewalProvider {
  readonly mode = "local-synthetic" as const;
  constructor(private readonly outcome: RenewalOutcome = "succeeded") {
    if (env.NODE_ENV === "production")
      throw new Error("Synthetic renewal provider is local only");
  }
  async renew(effect: RenewalEffect, signal: AbortSignal) {
    if (signal.aborted) throw new RenewalProviderError("OPERATION_TIMEOUT");
    await pool.query(
      `INSERT INTO synthetic_billing_renewal_effects
      (request_id,idempotency_key,outcome,provider_reference_digest)
      VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        effect.requestId,
        effect.idempotencyKey,
        this.outcome,
        createHash("sha256")
          .update(`synthetic-renewal:${effect.requestId}`)
          .digest("hex"),
      ],
    );
    return (
      await pool.query(
        "SELECT outcome FROM synthetic_billing_renewal_effects WHERE idempotency_key=$1",
        [effect.idempotencyKey],
      )
    ).rows[0]!.outcome as RenewalOutcome;
  }
}
export async function catalog() {
  return (
    await pool.query(
      "SELECT * FROM plans WHERE active ORDER BY monthly_minor,id",
    )
  ).rows;
}
export async function overview(actor: string, org: string) {
  await requireTenant(actor, org, "manage");
  return {
    entitlements: await entitlements(pool, org),
    usageMetering: await organizationUsage(actor, org),
    invoices: (
      await pool.query(
        "SELECT id,currency,amount_minor,state,provider,created_at FROM invoices WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
        [org],
      )
    ).rows,
    renewals: (
      await pool.query(
        `SELECT id,plan_id,period,prior_period_end,amount_minor,currency,state,attempts,
        last_error_code,created_at,finished_at FROM billing_renewal_requests
        WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 25`,
        [org],
      )
    ).rows,
  };
}
export async function checkout(
  actor: string,
  org: string,
  input: unknown,
  provider?: PaymentProvider,
) {
  if (!provider || provider.mode !== "sandbox")
    throw new HttpError(503, "Payment provider is not configured");
  const { planId, period } = z
    .object({
      planId: z.string().max(40),
      period: z.enum(["monthly", "yearly"]),
    })
    .strict()
    .parse(input);
  return tenantWrite(actor, org, "owner", async (db) => {
    if (
      !(await db.query("SELECT 1 FROM plans WHERE id=$1 AND active", [planId]))
        .rowCount
    )
      throw new HttpError(404, "Plan not available");
    const row = (
      await db.query(
        "INSERT INTO billing_checkouts(organization_id,plan_id,period,expected_version,amount_minor,currency,entitlement_snapshot,catalog_version) SELECT $1,p.id,$3,COALESCE((SELECT version FROM organization_subscriptions WHERE organization_id=$1),0),CASE WHEN $3='yearly' THEN p.yearly_minor ELSE p.monthly_minor END,p.currency,plan_entitlements(p),p.catalog_version FROM plans p WHERE p.id=$2 AND p.active RETURNING id,expires_at,amount_minor,currency,catalog_version,entitlement_snapshot",
        [org, planId, period],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(409, "Catalog changed; request a fresh quote");
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "billing.sandbox_checkout_created",
      resourceId: row.id,
    });
    return { ...row, mode: "sandbox", livePayments: false };
  });
}
export async function cancel(actor: string, org: string) {
  return tenantWrite(actor, org, "owner", async (db) => {
    const result = await db.query(
      "UPDATE organization_subscriptions SET cancel_at_period_end=true,version=version+1,updated_at=NOW() WHERE organization_id=$1 RETURNING organization_id",
      [org],
    );
    if (!result.rowCount)
      throw new HttpError(409, "No subscription is configured");
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "billing.cancellation_requested",
      resourceId: org,
    });
  });
}
export async function webhook(
  raw: Buffer,
  signature: string,
  provider?: PaymentProvider,
) {
  if (!provider || provider.mode !== "sandbox")
    throw new HttpError(503, "Payment provider is not configured");
  const data = z
    .object({
      id: z.uuid(),
      checkoutId: z.uuid(),
      type: z.enum(["payment.succeeded", "payment.failed"]),
    })
    .strict()
    .parse(provider.verify(raw, signature));
  const payloadDigest = createHash("sha256").update(raw).digest("hex");
  return transaction(async (db) => {
    const reference = (
      await db.query(
        "SELECT organization_id FROM billing_checkouts WHERE id=$1",
        [data.checkoutId],
      )
    ).rows[0];
    if (!reference) throw new HttpError(404, "Checkout not found");
    await db.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      reference.organization_id,
    ]);
    const duplicate = (
      await db.query(
        "SELECT payload_digest FROM billing_webhook_events WHERE id=$1",
        [data.id],
      )
    ).rows[0];
    if (duplicate) {
      if (duplicate.payload_digest !== payloadDigest)
        throw new HttpError(409, "Event ID conflict");
      return { replayed: true };
    }
    const checkout = (
      await db.query("SELECT * FROM billing_checkouts WHERE id=$1 FOR UPDATE", [
        data.checkoutId,
      ])
    ).rows[0]!;
    if (
      checkout.state !== "pending" ||
      new Date(checkout.expires_at).getTime() <= Date.now()
    )
      throw new HttpError(409, "Checkout is no longer available");
    const version =
      (
        await db.query(
          "SELECT version FROM organization_subscriptions WHERE organization_id=$1",
          [reference.organization_id],
        )
      ).rows[0]?.version ?? 0;
    if (version !== checkout.expected_version)
      throw new HttpError(409, "Checkout subscription revision is stale");
    const plan = (
      await db.query("SELECT * FROM plans WHERE id=$1", [checkout.plan_id])
    ).rows[0]!;
    await db.query(
      "INSERT INTO billing_webhook_events(id,payload_digest) VALUES($1,$2)",
      [data.id, payloadDigest],
    );
    const success = data.type === "payment.succeeded";
    await db.query(
      "UPDATE billing_checkouts SET state='completed' WHERE id=$1",
      [checkout.id],
    );
    if (success)
      await db.query(
        `INSERT INTO organization_subscriptions(organization_id,plan_id,state,period,period_end,version,entitlement_snapshot,catalog_version)
      VALUES($1,$2,'active',$3,NOW()+CASE WHEN $3='yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END,1,$4,$5)
      ON CONFLICT(organization_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,state='active',period=EXCLUDED.period,
      period_end=EXCLUDED.period_end,grace_until=NULL,cancel_at_period_end=false,version=organization_subscriptions.version+1,updated_at=NOW(),entitlement_snapshot=EXCLUDED.entitlement_snapshot,catalog_version=EXCLUDED.catalog_version`,
        [
          reference.organization_id,
          plan.id,
          checkout.period,
          checkout.entitlement_snapshot,
          checkout.catalog_version,
        ],
      );
    else
      await db.query(
        `INSERT INTO organization_subscriptions(organization_id,plan_id,state,period_end,grace_until,version)
      VALUES($1,'development','past_due',NOW(),NOW()+INTERVAL '7 days',1)
      ON CONFLICT(organization_id) DO UPDATE SET state='past_due',grace_until=COALESCE(organization_subscriptions.grace_until,NOW()+INTERVAL '7 days'),version=organization_subscriptions.version+1,updated_at=NOW()`,
        [reference.organization_id],
      );
    await db.query(
      "INSERT INTO invoices(organization_id,event_id,currency,amount_minor,state) VALUES($1,$2,$3,$4,$5)",
      [
        reference.organization_id,
        data.id,
        checkout.currency,
        checkout.amount_minor,
        success ? "paid" : "failed",
      ],
    );
    await appendAudit(db, {
      organizationId: reference.organization_id,
      actorId: null,
      action: "billing.sandbox_" + data.type,
      resourceId: checkout.id,
    });
    return { replayed: false };
  });
}
export async function scheduleRenewals(organizationId?: string) {
  return transaction(async (db) => {
    const due = (
      await db.query(
        `SELECT s.*,p.monthly_minor,p.yearly_minor,p.currency FROM organization_subscriptions s
        JOIN plans p ON p.id=s.plan_id WHERE ($1::uuid IS NULL OR s.organization_id=$1)
        AND s.period_end<=NOW() AND s.state IN ('trial','active')
        ORDER BY s.organization_id LIMIT 50 FOR UPDATE OF s SKIP LOCKED`,
        [organizationId ?? null],
      )
    ).rows;
    let queued = 0;
    for (const row of due) {
      if (row.cancel_at_period_end) {
        await db.query(
          "UPDATE organization_subscriptions SET state='canceled',grace_until=NULL,version=version+1,updated_at=NOW() WHERE organization_id=$1",
          [row.organization_id],
        );
        continue;
      }
      if (row.state === "trial" || row.provider !== "sandbox") {
        await db.query(
          "UPDATE organization_subscriptions SET state='grace',grace_until=period_end+INTERVAL '7 days',version=version+1,updated_at=NOW() WHERE organization_id=$1",
          [row.organization_id],
        );
        continue;
      }
      const revision = (
        await db.query(
          `UPDATE organization_subscriptions SET state='grace',
          grace_until=period_end+INTERVAL '7 days',version=version+1,updated_at=NOW()
          WHERE organization_id=$1 RETURNING version`,
          [row.organization_id],
        )
      ).rows[0]!.version;
      queued += Number(
        (
          await db.query(
            `INSERT INTO billing_renewal_requests
            (organization_id,subscription_version,plan_id,period,prior_period_end,
            amount_minor,currency,entitlement_snapshot,catalog_version)
            SELECT s.organization_id,s.version,s.plan_id,s.period,s.period_end,
            CASE WHEN s.period='yearly' THEN p.yearly_minor ELSE p.monthly_minor END,
            p.currency,s.entitlement_snapshot,s.catalog_version
            FROM organization_subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.organization_id=$1 AND s.version=$2
            ON CONFLICT(organization_id,subscription_version,prior_period_end) DO NOTHING
            RETURNING id`,
            [row.organization_id, revision],
          )
        ).rowCount ?? 0,
      );
    }
    return queued;
  });
}

export async function runRenewalOnce(
  provider: RenewalProvider,
  options: {
    allowSynthetic?: boolean;
    leaseMs?: number;
    timeoutMs?: number;
    organizationId?: string;
  } = {},
) {
  if (provider.mode === "local-synthetic" && !options.allowSynthetic)
    throw new Error("Synthetic renewal provider requires explicit opt-in");
  const leaseMs = options.leaseMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (leaseMs < timeoutMs + 1000) throw new Error("Renewal lease too short");
  const claimed = await transaction(async (db) => {
    const row = (
      await db.query(
        `SELECT * FROM billing_renewal_requests WHERE
        (state='pending' OR (state='processing' AND lease_expires_at<NOW()))
        AND available_at<=NOW() AND ($1::uuid IS NULL OR organization_id=$1)
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [options.organizationId ?? null],
      )
    ).rows[0];
    if (!row) return null;
    const lease = randomUUID();
    await db.query(
      `UPDATE billing_renewal_requests SET state='processing',
      attempts=LEAST(attempts+1,max_attempts),lease_token=$2,
      lease_expires_at=NOW()+($3::integer*INTERVAL '1 millisecond') WHERE id=$1`,
      [row.id, lease, leaseMs],
    );
    return { ...row, lease };
  });
  if (!claimed) return "idle" as const;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let outcome: RenewalOutcome;
    try {
      outcome = await Promise.race([
        provider.renew(
          {
            idempotencyKey: claimed.id,
            requestId: claimed.id,
            organizationId: claimed.organization_id,
            planId: claimed.plan_id,
            period: claimed.period,
            amountMinor: claimed.amount_minor,
            currency: claimed.currency,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new RenewalProviderError("OPERATION_TIMEOUT")),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return transaction(async (db) => {
      const liveRequest = (
        await db.query(
          `SELECT id FROM billing_renewal_requests WHERE id=$1 AND state='processing'
          AND lease_token=$2 AND lease_expires_at>NOW() FOR UPDATE`,
          [claimed.id, claimed.lease],
        )
      ).rows[0];
      if (!liveRequest) return "stale" as const;
      const subscription = (
        await db.query(
          `SELECT s.version,s.state,s.version=r.subscription_version AS same_version,
          s.period_end=r.prior_period_end AS same_period FROM organization_subscriptions s
          JOIN billing_renewal_requests r ON r.id=$2
          WHERE s.organization_id=$1 FOR UPDATE OF s`,
          [claimed.organization_id, claimed.id],
        )
      ).rows[0];
      if (
        !subscription ||
        !subscription.same_version ||
        !subscription.same_period ||
        !["grace", "past_due"].includes(subscription.state)
      ) {
        await db.query(
          `UPDATE billing_renewal_requests SET state='superseded',finished_at=NOW(),
          lease_token=NULL,lease_expires_at=NULL,last_error_code='STALE_SUBSCRIPTION_REVISION'
          WHERE id=$1`,
          [claimed.id],
        );
        return "superseded" as const;
      }
      if (outcome === "succeeded")
        await db.query(
          `UPDATE organization_subscriptions SET state='active',
          period_end=(SELECT prior_period_end+CASE WHEN period='yearly' THEN INTERVAL '1 year'
            ELSE INTERVAL '1 month' END FROM billing_renewal_requests WHERE id=$2),
          grace_until=NULL,cancel_at_period_end=false,version=version+1,updated_at=NOW()
          WHERE organization_id=$1`,
          [claimed.organization_id, claimed.id],
        );
      else
        await db.query(
          `UPDATE organization_subscriptions SET state='past_due',
          grace_until=COALESCE(grace_until,(SELECT prior_period_end+INTERVAL '7 days'
            FROM billing_renewal_requests WHERE id=$2)),
          version=version+1,updated_at=NOW() WHERE organization_id=$1`,
          [claimed.organization_id, claimed.id],
        );
      await db.query(
        `UPDATE billing_renewal_requests SET state=$2,finished_at=NOW(),
        lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1`,
        [claimed.id, outcome],
      );
      await db.query(
        `INSERT INTO invoices(organization_id,event_id,renewal_request_id,currency,
        amount_minor,state,provider) VALUES($1,NULL,$2,$3,$4,$5,'sandbox')
        ON CONFLICT(renewal_request_id) DO NOTHING`,
        [
          claimed.organization_id,
          claimed.id,
          claimed.currency,
          claimed.amount_minor,
          outcome === "succeeded" ? "paid" : "failed",
        ],
      );
      await appendAudit(db, {
        organizationId: claimed.organization_id,
        actorId: null,
        action: `billing.sandbox_renewal_${outcome}`,
        resourceId: claimed.id,
        metadata: { subscriptionVersion: claimed.subscription_version },
      });
      return outcome;
    });
  } catch (error) {
    const code =
      error instanceof RenewalProviderError
        ? error.code
        : "OUTCOME_UNKNOWN";
    const result = (
      await pool.query(
        `UPDATE billing_renewal_requests SET
        state=CASE WHEN attempts<max_attempts THEN 'pending' ELSE 'uncertain' END,
        available_at=NOW()+INTERVAL '30 seconds',last_error_code=$3,
        lease_token=NULL,lease_expires_at=NULL,
        finished_at=CASE WHEN attempts>=max_attempts THEN NOW() ELSE NULL END
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING state`,
        [claimed.id, claimed.lease, code],
      )
    ).rows[0];
    return !result
      ? ("stale" as const)
      : result.state === "pending"
        ? ("retry" as const)
        : ("uncertain" as const);
  }
}

export async function advancePeriods(organizationId?: string) {
  const queued = await scheduleRenewals(organizationId);
  await transaction(async (db) => {
    await db.query(
      "WITH due AS (SELECT organization_id FROM organization_subscriptions WHERE ($1::uuid IS NULL OR organization_id=$1) AND state IN ('grace','past_due') AND grace_until<=NOW() LIMIT 50 FOR UPDATE SKIP LOCKED) UPDATE organization_subscriptions s SET state='canceled',version=version+1,updated_at=NOW() FROM due WHERE s.organization_id=due.organization_id",
      [organizationId ?? null],
    );
    await db.query(
      "WITH due AS (SELECT id FROM billing_checkouts WHERE ($1::uuid IS NULL OR organization_id=$1) AND state='pending' AND expires_at<=NOW() LIMIT 50 FOR UPDATE SKIP LOCKED) UPDATE billing_checkouts c SET state='expired' FROM due WHERE c.id=due.id",
      [organizationId ?? null],
    );
  });
  return queued;
}
