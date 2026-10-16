import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import {
  createMailbox,
  updateMailbox,
} from "../src/services/mailbox.service.js";
import { ProvisioningWorker } from "../src/workers/provisioning.worker.js";
import {
  ProvisioningError,
  type MailProvisioningAdapter,
  type MailboxTarget,
  type MailboxObservation,
} from "../src/services/provisioning.adapter.js";
import * as queue from "../src/repositories/provisioning.repository.js";
import {
  reconcileMailbox,
  retryRequest,
} from "../src/services/operations.service.js";
const owner = randomUUID(),
  org = randomUUID(),
  domain = randomUUID();
after(async () => {
  await pool.query("DELETE FROM mailboxes WHERE domain_id=$1", [domain]);
  await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=$1", [owner]);
  await pool.end();
});
class TestMailAdapter implements MailProvisioningAdapter {
  readonly mode = "live" as const;
  states = new Map<string, MailboxObservation>();
  calls: MailboxTarget[] = [];
  acceptedRevisions = new Map<string, number>();
  failures = 0;
  permanent = false;
  timeout = false;
  rawError = false;
  async inspect(target: MailboxTarget): Promise<MailboxObservation> {
    return (
      this.states.get(target.mailboxId) ?? {
        status: "absent",
        quotaMb: null,
        inboundPolicy: "unknown",
      }
    );
  }
  async ensure(
    target: MailboxTarget,
    signal: AbortSignal,
  ): Promise<{ status: "applied" }> {
    this.calls.push(target);
    if (this.rawError) throw new Error("private-provider-password-marker");
    if (this.timeout)
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new ProvisioningError("OPERATION_TIMEOUT", true)),
          { once: true },
        ),
      );
    if (this.permanent) throw new ProvisioningError("PROVIDER_REJECTED", false);
    if (this.failures-- > 0)
      throw new ProvisioningError("PROVIDER_UNAVAILABLE", true);
    if (target.revision < (this.acceptedRevisions.get(target.mailboxId) ?? 0))
      throw new ProvisioningError("PROVIDER_REJECTED", false);
    this.acceptedRevisions.set(target.mailboxId, target.revision);
    this.states.set(target.mailboxId, {
      status: target.status,
      quotaMb: target.quotaMb,
      inboundPolicy: target.inboundPolicy,
    });
    return { status: "applied" };
  }
}
async function due(id: string) {
  await pool.query(
    "UPDATE provisioning_requests SET available_at=NOW()-INTERVAL '1 second' WHERE mailbox_id=$1",
    [id],
  );
}
async function status(id: string) {
  return (await pool.query("SELECT * FROM mailboxes WHERE id=$1", [id]))
    .rows[0]!;
}
test("worker reliability: pending safety, serialized versions, recovery, retry, dead letters, timeout and reconciliation", async () => {
  await pool.query(
    "INSERT INTO users(id,email,password_hash) VALUES ($1,$2,$3)",
    [owner, `${owner}@example.test`, "test"],
  );
  await pool.query(
    "INSERT INTO organizations(id,name,slug) VALUES ($1,$2,$3)",
    [org, "Worker test", org],
  );
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES ($1,$2,'owner')",
    [owner, org],
  );
  await pool.query(
    "INSERT INTO domains(id,organization_id,name,verification_token,verification_status,mail_activation) VALUES ($1,$2,$3,'test','verified','local-lab')",
    [domain, org, `${domain}.example.test`],
  );
  const box = await createMailbox(owner, org, {
    domainId: domain,
    localPart: "worker",
    quotaMb: 100,
  });
  const pending = new ProvisioningWorker(undefined, { organizationId: org });
  assert.equal(await pending.runOnce(), "deferred");
  assert.equal((await status(box.id)).observed_status, "unknown");
  assert.equal(
    (
      await pool.query(
        "SELECT attempts FROM provisioning_requests WHERE mailbox_id=$1",
        [box.id],
      )
    ).rows[0]!.attempts,
    0,
  );
  await due(box.id);
  for (let round = 0; round < 12; round++) {
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => queue.claim(60000, org)),
    );
    assert.equal(
      concurrent.filter(Boolean).length,
      1,
      "Exactly one live lease may be claimed",
    );
    const claimed = concurrent.find(Boolean)!;
    await queue.finish(claimed, { kind: "deferred", delayMs: 0 });
    await due(box.id);
  }
  const racing = await Promise.all([
    queue.claim(60000, org),
    queue.claim(60000, org),
  ]);
  assert.equal(racing.filter(Boolean).length, 1);
  const first = racing.find((job) => job !== undefined);
  assert.ok(first);
  // A newer intent cannot be masked by completion of the older in-flight revision.
  await updateMailbox(owner, org, box.id, { quotaMb: 200 });
  assert.equal(
    await queue.finish(first, {
      kind: "completed",
      observation: {
        status: "active",
        quotaMb: 100,
        inboundPolicy: "accept",
      },
    }),
    true,
  );
  assert.equal(
    (await status(box.id)).provisioning_status,
    "pending_provisioning",
  );
  const adapter = new TestMailAdapter();
  const worker = new ProvisioningWorker(adapter, {
    organizationId: org,
    baseBackoffMs: 10,
  });
  adapter.failures = 1;
  assert.equal(await worker.runOnce(), "failed");
  const retry = (
    await pool.query(
      "SELECT * FROM provisioning_requests WHERE mailbox_id=$1 AND state='pending'",
      [box.id],
    )
  ).rows[0]!;
  assert.equal(retry.attempts, 1);
  assert.equal(retry.last_error_code, "PROVIDER_UNAVAILABLE");
  await due(box.id);
  assert.equal(await worker.runOnce(), "completed");
  assert.equal((await status(box.id)).observed_quota_mb, 200);
  assert.equal((await status(box.id)).applied_revision, 2);
  assert.equal(
    adapter.calls[0]!.idempotencyKey,
    adapter.calls[1]!.idempotencyKey,
  );
  // Drift creates fresh immutable desired revision, then independent inspection confirms repair.
  adapter.states.set(box.id, {
    status: "suspended",
    quotaMb: 100,
    inboundPolicy: "accept",
  });
  await reconcileMailbox(owner, org, box.id);
  assert.equal(await worker.runOnce(), "completed");
  assert.equal((await status(box.id)).desired_revision, 3);
  // A matching state still needs idempotent ensure to establish the remote revision fence.
  await updateMailbox(owner, org, box.id, { action: "suspend" });
  const crashed = await queue.claim(60000, org);
  assert.ok(crashed);
  adapter.states.set(box.id, {
    status: "suspended",
    quotaMb: 200,
    inboundPolicy: "accept",
  });
  await pool.query(
    "UPDATE provisioning_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [crashed.id],
  );
  const before = adapter.calls.length;
  assert.equal(await worker.runOnce(), "completed");
  assert.equal(adapter.calls.length, before + 1);
  assert.equal(adapter.calls.at(-1)!.revision, crashed.revision);
  assert.equal(adapter.calls.at(-1)!.idempotencyKey, crashed.id);
  assert.equal(adapter.acceptedRevisions.get(box.id), crashed.revision);
  await assert.rejects(
    adapter.ensure(
      { ...queue.target(crashed), revision: crashed.revision - 1 },
      AbortSignal.timeout(1000),
    ),
    ProvisioningError,
  );
  assert.equal(adapter.states.get(box.id)!.status, "suspended");
  assert.equal(
    await queue.finish(crashed, {
      kind: "completed",
      observation: {
        status: "active",
        quotaMb: 100,
        inboundPolicy: "accept",
      },
    }),
    false,
  );
  assert.equal((await status(box.id)).observed_status, "suspended");
  // A permanent dead letter blocks later mailbox revisions until reviewed retry.
  await updateMailbox(owner, org, box.id, { action: "resume" });
  adapter.permanent = true;
  assert.equal(await worker.runOnce(), "failed");
  await updateMailbox(owner, org, box.id, { quotaMb: 100 });
  assert.equal(await worker.runOnce(), "idle");
  const dead = (
    await pool.query(
      "SELECT id FROM provisioning_requests WHERE mailbox_id=$1 AND state='failed'",
      [box.id],
    )
  ).rows[0]!;
  await retryRequest(owner, org, dead.id);
  adapter.permanent = false;
  assert.equal(await worker.runOnce(), "completed");
  assert.equal(
    (await status(box.id)).provisioning_status,
    "pending_provisioning",
  );
  assert.equal(await worker.runOnce(), "completed");
  assert.equal((await status(box.id)).observed_quota_mb, 100);
  // Bounded retry budget and timeout handling never record fake observations.
  await updateMailbox(owner, org, box.id, { quotaMb: 200 });
  adapter.failures = 100;
  await pool.query(
    "UPDATE provisioning_requests SET max_attempts=2 WHERE mailbox_id=$1 AND state='pending'",
    [box.id],
  );
  assert.equal(await worker.runOnce(), "failed");
  await due(box.id);
  assert.equal(await worker.runOnce(), "failed");
  assert.equal(await worker.runOnce(), "idle");
  assert.equal((await status(box.id)).provisioning_status, "failed");
  const exhausted = (
    await pool.query(
      "SELECT id,attempts FROM provisioning_requests WHERE mailbox_id=$1 AND state='failed'",
      [box.id],
    )
  ).rows[0]!;
  assert.equal(exhausted.attempts, 2);
  await retryRequest(owner, org, exhausted.id);
  adapter.failures = 0;
  adapter.timeout = true;
  const timed = new ProvisioningWorker(adapter, {
    organizationId: org,
    timeoutMs: 10,
    leaseMs: 2000,
  });
  assert.equal(await timed.runOnce(), "failed");
  assert.equal((await status(box.id)).observed_quota_mb, 100);
  adapter.timeout = false;
  adapter.rawError = true;
  await due(box.id);
  assert.equal(await worker.runOnce(), "failed");
  const persisted = (
    await pool.query(
      "SELECT last_error_code FROM provisioning_requests WHERE mailbox_id=$1",
      [box.id],
    )
  ).rows;
  assert.equal(
    JSON.stringify(persisted).includes("private-provider-password-marker"),
    false,
  );
  assert.equal(
    (await status(box.id)).last_provisioning_error,
    "PROVIDER_UNAVAILABLE",
  );
  const codes = (
    await pool.query(
      "SELECT DISTINCT action FROM audit_events WHERE organization_id=$1",
      [org],
    )
  ).rows.map((r) => r.action);
  for (const event of [
    "provisioning.completed",
    "provisioning.lease_recovered",
    "provisioning.dead_lettered",
    "provisioning.retry_requested",
    "mailbox.reconciliation_requested",
  ])
    assert.ok(codes.includes(event));
});

test("restored processing jobs reconcile applied effects and cannot revert a provider revision ahead of the database", async () => {
  const box = await createMailbox(owner, org, {
    domainId: domain,
    localPart: "restored",
    quotaMb: 100,
  });
  const adapter = new TestMailAdapter();
  const worker = new ProvisioningWorker(adapter, { organizationId: org });
  // A restored snapshot retains a processing lease whose provider effect already occurred.
  // Scope claims to this fixture by leaving the earlier test's failed head blocked.
  const captured = await queue.claim(60000, org);
  assert.ok(captured);
  assert.equal(captured.mailbox_id, box.id);
  await adapter.ensure(queue.target(captured), AbortSignal.timeout(1000));
  await pool.query(
    "UPDATE provisioning_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [captured.id],
  );
  assert.equal(await worker.runOnce(), "completed");
  assert.equal(adapter.calls.at(-1)?.idempotencyKey, captured.id);
  assert.equal((await status(box.id)).applied_revision, captured.revision);
  assert.equal(
    await queue.finish(captured, {
      kind: "completed",
      observation: {
        status: "suspended",
        quotaMb: 200,
        inboundPolicy: "defer",
      },
    }),
    false,
  );
  assert.equal((await status(box.id)).observed_status, "active");
  // Model mismatched restore points: the remote journal is newer than restored intent.
  await updateMailbox(owner, org, box.id, { action: "suspend" });
  const desired = (await status(box.id)).desired_revision;
  adapter.acceptedRevisions.set(box.id, desired + 1);
  adapter.states.set(box.id, {
    status: "active",
    quotaMb: 200,
    inboundPolicy: "accept",
  });
  assert.equal(await worker.runOnce(), "failed");
  assert.deepEqual(adapter.states.get(box.id), {
    status: "active",
    quotaMb: 200,
    inboundPolicy: "accept",
  });
  assert.equal((await status(box.id)).applied_revision, captured.revision);
  const failure = (
    await pool.query(
      "SELECT state,last_error_code FROM provisioning_requests WHERE mailbox_id=$1 AND revision=$2",
      [box.id, desired],
    )
  ).rows[0];
  assert.equal(failure.state, "failed");
  assert.equal(failure.last_error_code, "PROVIDER_REJECTED");
});
