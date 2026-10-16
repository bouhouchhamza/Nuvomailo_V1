import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import pool from "../src/config/database.js";
import { createOrganization } from "../src/services/tenant.service.js";
import {
  createMailbox,
  updateMailbox,
} from "../src/services/mailbox.service.js";
import * as billing from "../src/services/billing.service.js";
const owner = randomUUID(),
  other = randomUUID(),
  key = randomBytes(32),
  provider = new billing.SandboxPaymentProvider(key);
let org: string, domain: string;
const quotePlan = "quote-" + randomUUID().replaceAll("-", "").slice(0, 20);
after(async () => {
  if (domain)
    await pool.query("DELETE FROM mailboxes WHERE domain_id=$1", [domain]);
  if (org) await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM plans WHERE id=$1", [quotePlan]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other],
  ]);
  await pool.end();
});
function signed(value: unknown, time = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    raw,
    signature: `t=${time},v1=${createHmac("sha256", key)
      .update(time + ".")
      .update(raw)
      .digest("hex")}`,
  };
}
test("sandbox billing verifies signed raw events, rejects replay mutation/stale revisions and preserves mail; entitlements allow configurable quotas", async () => {
  for (const id of [owner, other])
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",
      [id, `${id}@example.test`],
    );
  org = (
    await createOrganization(owner, {
      name: "Billing fixture",
      slug: randomUUID(),
    })
  ).id;
  domain = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,verification_status) VALUES($1,$2,'synthetic','verified') RETURNING id",
      [org, `${org}.example.test`],
    )
  ).rows[0]!.id;
  await assert.rejects(billing.overview(other, org));
  await assert.rejects(
    billing.checkout(owner, org, { planId: "sandbox-team", period: "monthly" }),
  );
  await assert.rejects(
    createMailbox(owner, org, {
      domainId: domain,
      localPart: "before-upgrade",
      quotaMb: 500,
    }),
  );
  const stale = await billing.checkout(
    owner,
    org,
    { planId: "development", period: "monthly" },
    provider,
  );
  const checkout = await billing.checkout(
    owner,
    org,
    { planId: "sandbox-team", period: "monthly" },
    provider,
  );
  const value = {
    id: randomUUID(),
    checkoutId: checkout.id,
    type: "payment.succeeded",
  };
  const event = signed(value);
  await assert.rejects(
    billing.webhook(event.raw, "t=1234567890,v1=" + "0".repeat(64), provider),
  );
  const expired = signed(value, Math.floor(Date.now() / 1000) - 3600);
  await assert.rejects(
    billing.webhook(expired.raw, expired.signature, provider),
  );
  const simultaneous = await Promise.all([
    billing.webhook(event.raw, event.signature, provider),
    billing.webhook(event.raw, event.signature, provider),
  ]);
  assert.equal(simultaneous.filter((v) => !v.replayed).length, 1);
  const mutation = signed({ ...value, type: "payment.failed" });
  await assert.rejects(
    billing.webhook(mutation.raw, mutation.signature, provider),
  );
  const staleEvent = signed({
    id: randomUUID(),
    checkoutId: stale.id,
    type: "payment.succeeded",
  });
  await assert.rejects(
    billing.webhook(staleEvent.raw, staleEvent.signature, provider),
  );
  const box = await createMailbox(owner, org, {
    domainId: domain,
    localPart: "configurable",
    quotaMb: 1024,
  });
  assert.equal(box.quota_mb, 1024);
  assert.equal(box.liveMailAvailable, false);
  const fail = await billing.checkout(
    owner,
    org,
    { planId: "sandbox-team", period: "yearly" },
    provider,
  );
  const failed = signed({
    id: randomUUID(),
    checkoutId: fail.id,
    type: "payment.failed",
  });
  await billing.webhook(failed.raw, failed.signature, provider);
  await pool.query(
    "UPDATE organization_subscriptions SET grace_until=NOW()-INTERVAL '1 second' WHERE organization_id=$1",
    [org],
  );
  await assert.rejects(
    createMailbox(owner, org, {
      domainId: domain,
      localPart: "overdue",
      quotaMb: 100,
    }),
  );
  await updateMailbox(owner, org, box.id, { quotaMb: 500 });
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS n FROM mailboxes WHERE id=$1", [
        box.id,
      ])
    ).rows[0]!.n,
    1,
  );
  assert.equal((await billing.overview(owner, org)).invoices.length, 2);
  await billing.cancel(owner, org);
});

test("immutable checkout quotes survive catalog changes and cancellation retains mailbox data", async () => {
  await pool.query(
    "INSERT INTO plans(id,name,currency,monthly_minor,yearly_minor,max_domains,max_mailboxes,max_members,max_quota_mb,storage_mb,max_mailboxes_per_domain,active) SELECT $1,'Quote fixture','USD',1999,19990,max_domains,max_mailboxes,max_members,max_quota_mb,storage_mb,max_mailboxes_per_domain,true FROM plans WHERE id='sandbox-team'",
    [quotePlan],
  );
  const checkout = await billing.checkout(
    owner,
    org,
    { planId: quotePlan, period: "monthly" },
    provider,
  );
  assert.equal(checkout.amount_minor, 1999);
  assert.equal(checkout.catalog_version, 1);
  const quota = checkout.entitlement_snapshot.max_quota_mb;
  await pool.query(
    "UPDATE plans SET monthly_minor=2999,max_quota_mb=100 WHERE id=$1",
    [quotePlan],
  );
  await assert.rejects(
    pool.query("UPDATE billing_checkouts SET amount_minor=1 WHERE id=$1", [
      checkout.id,
    ]),
  );
  const event = signed({
    id: randomUUID(),
    checkoutId: checkout.id,
    type: "payment.succeeded",
  });
  await billing.webhook(event.raw, event.signature, provider);
  const invoice = (
    await pool.query("SELECT amount_minor FROM invoices WHERE event_id=$1", [
      JSON.parse(event.raw.toString()).id,
    ])
  ).rows[0]!;
  assert.equal(invoice.amount_minor, 1999);
  const captured = (await billing.overview(owner, org)).entitlements;
  assert.equal(captured.max_quota_mb, quota);
  assert.equal(captured.catalog_version, 1);
  assert.equal(captured.snapshotFrozen, true);
  await updateMailbox(
    owner,
    org,
    (
      await pool.query("SELECT id FROM mailboxes WHERE domain_id=$1 LIMIT 1", [
        domain,
      ])
    ).rows[0]!.id,
    { quotaMb: 3000 },
  );
  assert.equal(
    (
      await pool.query("SELECT catalog_version FROM plans WHERE id=$1", [
        quotePlan,
      ])
    ).rows[0]!.catalog_version,
    2,
  );
  await billing.cancel(owner, org);
  await pool.query(
    "UPDATE organization_subscriptions SET period_end=NOW()-INTERVAL '1 day' WHERE organization_id=$1",
    [org],
  );
  await billing.advancePeriods(org);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM organization_subscriptions WHERE organization_id=$1",
        [org],
      )
    ).rows[0]!.state,
    "canceled",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM mailboxes WHERE domain_id=$1",
        [domain],
      )
    ).rows[0]!.n,
    1,
  );
});

test("sandbox renewals fence replay, unknown outcomes, failures, cancellation and stale revisions while retaining mail", async () => {
  async function armRenewal() {
    return (
      await pool.query(
        `UPDATE organization_subscriptions s SET plan_id=p.id,state='active',period='monthly',
        period_end=NOW()-INTERVAL '1 hour',grace_until=NULL,cancel_at_period_end=false,
        provider='sandbox',version=s.version+1,entitlement_snapshot=plan_entitlements(p),
        catalog_version=p.catalog_version,updated_at=NOW() FROM plans p
        WHERE s.organization_id=$1 AND p.id='sandbox-team'
        RETURNING s.version,s.period_end`,
        [org],
      )
    ).rows[0]!;
  }
  const first = await armRenewal();
  assert.equal(await billing.scheduleRenewals(org), 1);
  assert.equal(await billing.scheduleRenewals(org), 0);
  const request = (
    await pool.query(
      "SELECT * FROM billing_renewal_requests WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1",
      [org],
    )
  ).rows[0]!;
  assert.equal(request.subscription_version, first.version + 1);
  assert.equal(request.amount_minor, 0);
  const durable = new billing.SyntheticRenewalProvider("succeeded");
  const crashAfterEffect: billing.RenewalProvider = {
    mode: "local-synthetic",
    async renew(effect, signal) {
      await durable.renew(effect, signal);
      throw new billing.RenewalProviderError("OUTCOME_UNKNOWN");
    },
  };
  assert.equal(
    await billing.runRenewalOnce(crashAfterEffect, {
      allowSynthetic: true,
      organizationId: org,
    }),
    "retry",
  );
  await pool.query(
    "UPDATE billing_renewal_requests SET available_at=NOW() WHERE id=$1",
    [request.id],
  );
  assert.equal(
    await billing.runRenewalOnce(durable, {
      allowSynthetic: true,
      organizationId: org,
    }),
    "succeeded",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM synthetic_billing_renewal_effects WHERE request_id=$1",
        [request.id],
      )
    ).rows[0]!.n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM invoices WHERE renewal_request_id=$1",
        [request.id],
      )
    ).rows[0]!.n,
    1,
  );
  assert.equal(
    await billing.runRenewalOnce(durable, {
      allowSynthetic: true,
      organizationId: org,
    }),
    "idle",
  );
  let subscription = (
    await pool.query(
      "SELECT state,period_end,grace_until FROM organization_subscriptions WHERE organization_id=$1",
      [org],
    )
  ).rows[0]!;
  assert.equal(subscription.state, "active");
  assert.equal(subscription.grace_until, null);
  assert.ok(
    new Date(subscription.period_end).getTime() >
      new Date(first.period_end).getTime(),
  );

  await armRenewal();
  assert.equal(await billing.scheduleRenewals(org), 1);
  const failedRequest = (
    await pool.query(
      "SELECT id FROM billing_renewal_requests WHERE organization_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1",
      [org],
    )
  ).rows[0]!.id;
  assert.equal(
    await billing.runRenewalOnce(
      new billing.SyntheticRenewalProvider("failed"),
      { allowSynthetic: true, organizationId: org },
    ),
    "failed",
  );
  subscription = (
    await pool.query(
      "SELECT state,grace_until FROM organization_subscriptions WHERE organization_id=$1",
      [org],
    )
  ).rows[0]!;
  assert.equal(subscription.state, "past_due");
  assert.ok(subscription.grace_until);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM invoices WHERE renewal_request_id=$1",
        [failedRequest],
      )
    ).rows[0]!.state,
    "failed",
  );

  await armRenewal();
  assert.equal(await billing.scheduleRenewals(org), 1);
  const staleRequest = (
    await pool.query(
      "SELECT id FROM billing_renewal_requests WHERE organization_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1",
      [org],
    )
  ).rows[0]!.id;
  const changeRevisionAfterEffect: billing.RenewalProvider = {
    mode: "local-synthetic",
    async renew(effect, signal) {
      const outcome = await durable.renew(effect, signal);
      await pool.query(
        "UPDATE organization_subscriptions SET version=version+1 WHERE organization_id=$1",
        [org],
      );
      return outcome;
    },
  };
  assert.equal(
    await billing.runRenewalOnce(changeRevisionAfterEffect, {
      allowSynthetic: true,
      organizationId: org,
    }),
    "superseded",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM billing_renewal_requests WHERE id=$1",
        [staleRequest],
      )
    ).rows[0]!.state,
    "superseded",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM invoices WHERE renewal_request_id=$1",
        [staleRequest],
      )
    ).rows[0]!.n,
    0,
  );

  await armRenewal();
  assert.equal(await billing.scheduleRenewals(org), 1);
  const uncertainRequest = (
    await pool.query(
      "SELECT id FROM billing_renewal_requests WHERE organization_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1",
      [org],
    )
  ).rows[0]!.id;
  await pool.query(
    "UPDATE billing_renewal_requests SET max_attempts=1 WHERE id=$1",
    [uncertainRequest],
  );
  assert.equal(
    await billing.runRenewalOnce(crashAfterEffect, {
      allowSynthetic: true,
      organizationId: org,
    }),
    "uncertain",
  );
  assert.equal(
    await billing.runRenewalOnce(durable, {
      allowSynthetic: true,
      organizationId: org,
    }),
    "idle",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM billing_renewal_requests WHERE id=$1",
        [uncertainRequest],
      )
    ).rows[0]!.state,
    "uncertain",
  );

  await armRenewal();
  await billing.cancel(owner, org);
  assert.equal(await billing.scheduleRenewals(org), 0);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM organization_subscriptions WHERE organization_id=$1",
        [org],
      )
    ).rows[0]!.state,
    "canceled",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM mailboxes WHERE domain_id=$1",
        [domain],
      )
    ).rows[0]!.n,
    1,
  );
});
