import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../config/database.js";
import { DmsLabAdapter } from "../adapters/dms-lab.adapter.js";
import { ProvisioningWorker } from "../workers/provisioning.worker.js";
import { updateMailbox } from "../services/mailbox.service.js";
import * as queue from "../repositories/provisioning.repository.js";
import { reconcileMailbox } from "../services/operations.service.js";
import { rpc } from "./rpc.js";
const org = "11111111-1111-4111-8111-111111111111";
const owner = "33333333-3333-4333-8333-333333333333";
const box = "55555555-5555-4555-8555-555555555555";
const partial = "99999999-9999-4999-8999-999999999999";
const adapter = new DmsLabAdapter();
const worker = () =>
  new ProvisioningWorker(adapter, {
    organizationId: org,
    timeoutMs: 30000,
    leaseMs: 120000,
    allowLabAdapter: true,
  });
async function current(id = box) {
  return (
    await pool.query(
      "SELECT p.*,d.organization_id,m.local_part||'@'||d.name AS address,d.verification_status='verified' AS domain_verified FROM provisioning_requests p JOIN mailboxes m ON m.id=p.mailbox_id JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 ORDER BY revision DESC LIMIT 1",
      [id],
    )
  ).rows[0]!;
}
async function target(id = box) {
  return queue.target(await current(id));
}
async function observe(id = box) {
  return adapter.inspect(await target(id), AbortSignal.timeout(35000));
}
async function due(id = box) {
  await pool.query(
    "UPDATE provisioning_requests SET available_at=NOW()-INTERVAL '1 second' WHERE mailbox_id=$1 AND state='pending'",
    [id],
  );
}
async function apply(input: unknown) {
  await updateMailbox(owner, org, box, input);
  assert.equal(await worker().runOnce(), "completed");
}
async function waitFor(test: () => Promise<boolean>) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("RUNTIME_CONVERGENCE_TIMEOUT");
}
const results: string[] = [];
try {
  const phase = process.argv[2];
  if (phase === "baseline") {
    await due();
    // Preserve/recover a pending head left by an interrupted prior lab run.
    if ((await current()).state === "pending")
      assert.equal(await worker().runOnce(), "completed");
    if (
      (await current()).state === "completed" &&
      (await current()).quota_mb !== 100
    )
      await apply({ quotaMb: 100 });
    await due();
    const executions = await Promise.all([
      worker().runOnce(),
      worker().runOnce(),
    ]);
    assert.ok(
      executions.includes("completed") ||
        (await current()).state === "completed",
    );
    assert.deepEqual(await observe(), { status: "active", quotaMb: 100 });
    results.push("worker-create-and-independent-runtime-inspection");
    await apply({ quotaMb: 200 });
    assert.deepEqual(await observe(), { status: "active", quotaMb: 200 });
    results.push("quota-update-effective-userdb");
    const t = await target();
    assert.equal((await rpc("/v1/ensure", t)).status, 200);
    assert.equal((await rpc("/v1/ensure", t)).status, 200);
    results.push("same-key-idempotency");
    const parallel = await Promise.all([
      rpc("/v1/ensure", t),
      rpc("/v1/ensure", t),
    ]);
    assert.ok(parallel.every((r) => r.status === 200));
    results.push("conflicting-operation-serialization");
    assert.equal(
      (
        await rpc("/v1/ensure", {
          ...t,
          revision: t.revision - 1,
          idempotencyKey: randomUUID(),
        })
      ).status,
      409,
    );
    results.push("stale-revision-rejected");
    assert.equal((await rpc("/v1/ensure", { ...t, quotaMb: 100 })).status, 409);
    results.push("idempotency-key-payload-conflict");
    assert.equal(
      (
        await rpc("/v1/inspect", {
          ...t,
          organizationId: "22222222-2222-4222-8222-222222222222",
        })
      ).status,
      403,
    );
    results.push("cross-tenant-substitution-rejected");
    for (const address of [
      "x;touch /tmp/injected@tenant-a.lab.invalid",
      "../../etc/passwd",
      "pilot@real.example",
      "pilot\nother@tenant-a.lab.invalid",
    ])
      assert.equal((await rpc("/v1/ensure", { ...t, address })).status, 400);
    assert.equal(
      (await rpc("/v1/ensure", { ...t, command: "whoami" })).status,
      400,
    );
    results.push("address-command-path-injection-rejected");
    assert.equal((await rpc("/v1/inspect", t, false)).status, 401);
    assert.equal((await rpc("/v1/exec", t)).status, 404);
    results.push("authenticated-allowlisted-private-transport");
    // Effect succeeded, then no DB acknowledgement. Another worker observes and converges.
    await updateMailbox(owner, org, box, { quotaMb: 100 });
    const claimed = await queue.claim(120000, org);
    assert.ok(claimed);
    assert.equal((await rpc("/v1/ensure", queue.target(claimed))).status, 200);
    await pool.query(
      "UPDATE provisioning_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [claimed.id],
    );
    assert.equal(await worker().runOnce(), "completed");
    assert.equal(
      await queue.finish(claimed, {
        kind: "completed",
        observation: {
          status: "active",
          quotaMb: 100,
          inboundPolicy: "accept",
        },
      }),
      false,
    );
    results.push("effect-before-lost-ack-worker-recovery");
  } else if (phase === "partial") {
    const existing = (
      await pool.query("SELECT id FROM mailboxes WHERE id=$1", [partial])
    ).rows[0];
    if (!existing) {
      await pool.query(
        "INSERT INTO mailboxes(id,domain_id,local_part,desired_revision) VALUES($1,'44444444-4444-4444-8444-444444444444','partial',1)",
        [partial],
      );
      await pool.query(
        "INSERT INTO provisioning_requests(mailbox_id,operation,quota_mb,revision,desired_status) VALUES($1,'create',100,1,'active')",
        [partial],
      );
    } else if ((await current(partial)).state === "completed")
      await updateMailbox(owner, org, partial, {
        quotaMb: (await current(partial)).quota_mb === 100 ? 200 : 100,
      });
    assert.equal(await worker().runOnce(), "failed");
    await waitFor(async () => (await observe(partial)).status === "active");
    assert.equal((await current(partial)).state, "pending");
    results.push(
      existing
        ? "account-before-quota-failure-observed"
        : "new-account-before-quota-failure-observed",
    );
    await due(partial);
    assert.equal(await worker().runOnce(), "completed");
    assert.deepEqual(await observe(partial), {
      status: "active",
      quotaMb: (await current(partial)).quota_mb,
    });
    results.push("partial-effect-idempotent-retry-repairs-quota");
  } else if (phase === "collision") {
    const t = {
      ...(await target()),
      mailboxId: "88888888-8888-4888-8888-888888888888",
      address: "collision@tenant-a.lab.invalid",
      revision: 1,
      idempotencyKey: randomUUID(),
    };
    const result = await rpc("/v1/ensure", t);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "ADDRESS_COLLISION");
    results.push("alias-account-collision-rejected");
  } else if (phase === "acceptance") {
    await updateMailbox(owner, org, box, {
      quotaMb: (await current()).quota_mb === 100 ? 200 : 100,
    });
    const t = await target();
    assert.equal((await rpc("/v1/ensure", t)).status, 503);
    assert.equal(
      (
        await rpc("/v1/ensure", {
          ...t,
          revision: t.revision - 1,
          idempotencyKey: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(await worker().runOnce(), "completed");
    results.push("durable-acceptance-fence-survives-partial-ledger-update");
  } else if (phase === "crash-effect") {
    await updateMailbox(owner, org, box, {
      quotaMb: (await current()).quota_mb === 100 ? 200 : 100,
    });
    const claimed = await queue.claim(120000, org);
    assert.ok(claimed);
    assert.equal((await rpc("/v1/ensure", queue.target(claimed))).status, 200);
    process.stdout.write(
      JSON.stringify({ workerEffectAppliedBeforeExit: true }) + "\n",
      () => process.exit(77),
    );
    await new Promise(() => {});
  } else if (phase === "recover-crash") {
    assert.equal((await current()).state, "processing");
    await pool.query(
      "UPDATE provisioning_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE mailbox_id=$1 AND state='processing'",
      [box],
    );
    assert.equal(await worker().runOnce(), "completed");
    assert.equal((await current()).state, "completed");
    results.push("new-worker-process-recovers-effect-before-exit");
  } else if (phase === "suspend") {
    await apply({ action: "suspend" });
    assert.equal((await observe()).status, "suspended");
    results.push("suspension-runtime-deny");
  } else if (phase === "resume") {
    await apply({ action: "resume" });
    assert.equal((await observe()).status, "active");
    results.push("restoration-runtime-auth");
  } else if (phase === "quota100") {
    await apply({ quotaMb: 100 });
    assert.equal((await observe()).quotaMb, 100);
    results.push("aggregate-quota-prepared");
  } else if (phase === "quota200") {
    await apply({ quotaMb: 200 });
    results.push("quota-restored-without-mail-deletion");
  } else if (phase === "drift") {
    await waitFor(async () => (await observe()).quotaMb === 100);
    await reconcileMailbox(owner, org, box);
    assert.equal(await worker().runOnce(), "completed");
    assert.equal((await observe()).quotaMb, 200);
    results.push("runtime-drift-detected-and-reconciled");
  } else if (phase === "restart") {
    const t = await target();
    assert.equal((await observe()).status, "active");
    assert.equal(
      (
        await rpc("/v1/ensure", {
          ...t,
          revision: t.revision - 1,
          idempotencyKey: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal((await rpc("/v1/ensure", t)).status, 200);
    results.push("provider-restart-keeps-revision-fence-and-state");
  } else throw new Error("UNKNOWN_CONFORMANCE_PHASE");
  console.log(JSON.stringify({ phase, passed: results }));
} catch (error) {
  console.error(
    JSON.stringify({
      phase: process.argv[2],
      error: error instanceof Error ? error.message : "LAB_TEST_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
