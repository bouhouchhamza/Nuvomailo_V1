import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { registerUser } from "../src/services/auth.service.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { createDomain, verifyDomain } from "../src/services/domain.service.js";
import {
  runDomainNotificationOnce,
  runRevalidationOnce,
  scheduleDueRevalidations,
} from "../src/services/domain-revalidation-worker.service.js";
import {
  SyntheticDomainNotificationTransport,
  type DomainNotificationEvent,
} from "../src/services/domain-notification.adapter.js";
import { ProvisioningWorker } from "../src/workers/provisioning.worker.js";
import type {
  MailboxObservation,
  MailboxTarget,
} from "../src/services/provisioning.adapter.js";

const password = "SyntheticScheduledDomain123!";
let actor = "",
  org = "";
after(async () => {
  if (org) {
    await pool.query(
      "DELETE FROM mailboxes WHERE domain_id IN(SELECT id FROM domains WHERE organization_id=$1)",
      [org],
    );
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  }
  if (actor) await pool.query("DELETE FROM users WHERE id=$1", [actor]);
  await pool.end();
});

test("scheduled revalidation is revision-fenced, recovers expired leases and delivers idempotent verified-owner warnings", async () => {
  actor = (
    await registerUser({
      email: `${randomUUID()}@example.test`,
      password,
    })
  ).id;
  await pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
    actor,
  ]);
  org = (
    await createOrganization(actor, {
      name: "Scheduled domain",
      slug: randomUUID(),
    })
  ).id;
  const domain = await createDomain(actor, org, {
    name: `${randomUUID()}.example.test`,
  });
  const answer = [[domain.dnsChallenge.value]];
  await verifyDomain(actor, org, domain.id, async () => answer);
  await pool.query(
    "UPDATE domains SET revalidation_due_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [domain.id],
  );
  assert.equal(await scheduleDueRevalidations(10, org), 1);
  assert.equal(await scheduleDueRevalidations(10, org), 0);
  await pool.query(
    `UPDATE domain_revalidation_requests SET state='processing',attempts=1,
    lease_token=$2,lease_expires_at=NOW()-INTERVAL '1 second' WHERE domain_id=$1`,
    [domain.id, randomUUID()],
  );
  let lookups = 0;
  const results = await Promise.all([
    runRevalidationOnce(
      async () => {
        lookups++;
        return [];
      },
      { organizationId: org },
    ),
    runRevalidationOnce(
      async () => {
        lookups++;
        return [];
      },
      { organizationId: org },
    ),
  ]);
  assert.equal(lookups, 1);
  assert.deepEqual(new Set(results), new Set(["warning", "idle"]));
  assert.equal(
    (
      await pool.query("SELECT revalidation_state FROM domains WHERE id=$1", [
        domain.id,
      ])
    ).rows[0].revalidation_state,
    "warning",
  );
  const synthetic = new SyntheticDomainNotificationTransport();
  let effectCompleted = false;
  const crashAfterEffect = {
    mode: "local-synthetic" as const,
    async deliver(event: DomainNotificationEvent, signal: AbortSignal) {
      await synthetic.deliver(event, signal);
      effectCompleted = true;
      await pool.query(
        "UPDATE domain_notification_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
        [event.outboxId],
      );
    },
  };
  assert.equal(
    await runDomainNotificationOnce(crashAfterEffect, {
      allowSynthetic: true,
    }),
    "stale",
  );
  assert.equal(effectCompleted, true);
  assert.equal(
    await runDomainNotificationOnce(synthetic, { allowSynthetic: true }),
    "delivered",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM synthetic_notification_deliveries WHERE recipient_user_id=$1",
          [actor],
        )
      ).rows[0].count,
    ),
    1,
  );

  const mailbox = (
    await pool.query(
      "INSERT INTO mailboxes(domain_id,local_part,quota_mb) VALUES($1,'custody',100) RETURNING id",
      [domain.id],
    )
  ).rows[0];
  await pool.query(
    `UPDATE domains SET revalidation_due_at=NOW()-INTERVAL '1 second',
    revalidation_grace_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,
    [domain.id],
  );
  assert.equal(await scheduleDueRevalidations(10, org), 1);
  assert.equal(
    await runRevalidationOnce(async () => [], { organizationId: org }),
    "failed",
  );
  const custody = (
    await pool.query(
      `SELECT m.desired_status,m.desired_inbound_policy,p.operation,p.inbound_policy
      FROM mailboxes m JOIN provisioning_requests p ON p.mailbox_id=m.id
      WHERE m.id=$1 AND p.state='pending'`,
      [mailbox.id],
    )
  ).rows[0];
  assert.deepEqual(
    {
      status: custody.desired_status,
      policy: custody.desired_inbound_policy,
      operation: custody.operation,
      snapshotPolicy: custody.inbound_policy,
    },
    {
      status: "suspended",
      policy: "defer",
      operation: "domain_custody",
      snapshotPolicy: "defer",
    },
  );
  let providerState: MailboxObservation = {
    status: "active",
    quotaMb: 100,
    inboundPolicy: "accept",
  };
  let appliedTarget: MailboxTarget | undefined;
  const custodyProvider = {
    mode: "live" as const,
    async inspect() {
      return providerState;
    },
    async ensure(target: MailboxTarget) {
      appliedTarget = target;
      providerState = {
        status: target.status,
        quotaMb: target.quotaMb,
        inboundPolicy: target.inboundPolicy,
      };
      return { status: "applied" as const };
    },
  };
  assert.equal(
    await new ProvisioningWorker(custodyProvider, {
      organizationId: org,
    }).runOnce(),
    "completed",
  );
  assert.equal(appliedTarget?.status, "suspended");
  assert.equal(appliedTarget?.inboundPolicy, "defer");
  assert.deepEqual(providerState, {
    status: "suspended",
    quotaMb: 100,
    inboundPolicy: "defer",
  });
  await pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
    actor,
  ]);
  await pool.query(
    `UPDATE domain_notification_outbox SET state='processing',attempts=1,
    lease_token=$2,lease_expires_at=NOW()-INTERVAL '1 second'
    WHERE recipient_user_id=$1 AND state='pending'`,
    [actor, randomUUID()],
  );
  assert.equal(
    await runDomainNotificationOnce(synthetic, { allowSynthetic: true }),
    "canceled",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM synthetic_notification_deliveries WHERE recipient_user_id=$1",
          [actor],
        )
      ).rows[0].count,
    ),
    1,
  );

  const staleDomain = await createDomain(actor, org, {
    name: `${randomUUID()}.example.test`,
  });
  await pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
    actor,
  ]);
  await verifyDomain(actor, org, staleDomain.id, async () => [
    [staleDomain.dnsChallenge.value],
  ]);
  await pool.query(
    "UPDATE domains SET revalidation_due_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [staleDomain.id],
  );
  assert.equal(await scheduleDueRevalidations(10, org), 1);
  await pool.query(
    "UPDATE domains SET revalidation_revision=revalidation_revision+1 WHERE id=$1",
    [staleDomain.id],
  );
  let staleLookup = false;
  assert.equal(
    await runRevalidationOnce(
      async () => {
        staleLookup = true;
        return [];
      },
      { organizationId: org },
    ),
    "superseded",
  );
  assert.equal(staleLookup, false);
});
