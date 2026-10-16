import assert from "node:assert/strict";
import pool from "../config/database.js";
import { DmsLabAdapter } from "../adapters/dms-lab.adapter.js";
import { ProvisioningWorker } from "../workers/provisioning.worker.js";
import { updateMailbox } from "../services/mailbox.service.js";
import { transaction } from "../repositories/transaction.js";
import { queueFailedDomainCustody } from "../repositories/domain-custody.repository.js";
import * as queue from "../repositories/provisioning.repository.js";

const org = "11111111-1111-4111-8111-111111111111";
const owner = "33333333-3333-4333-8333-333333333333";
const domain = "44444444-4444-4444-8444-444444444444";
const mailbox = "55555555-5555-4555-8555-555555555555";
const adapter = new DmsLabAdapter();
const worker = () =>
  new ProvisioningWorker(adapter, {
    organizationId: org,
    timeoutMs: 30_000,
    leaseMs: 120_000,
    allowLabAdapter: true,
  });

async function latest() {
  return (
    await pool.query(
      `SELECT p.*,d.organization_id,m.local_part||'@'||d.name AS address,
      d.verification_status='verified' AS domain_verified,d.mail_activation='local-lab' AS domain_enabled
      FROM provisioning_requests p JOIN mailboxes m ON m.id=p.mailbox_id
      JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 ORDER BY p.revision DESC LIMIT 1`,
      [mailbox],
    )
  ).rows[0]!;
}

async function applyLatest() {
  const expected = (await latest()).id;
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = (
      await pool.query("SELECT state FROM provisioning_requests WHERE id=$1", [
        expected,
      ])
    ).rows[0]?.state;
    if (state === "completed") return;
    if (state === "failed") throw new Error("CUSTODY_JOB_FAILED");
    await pool.query(
      "UPDATE provisioning_requests SET available_at=NOW() WHERE id=$1 AND state='pending'",
      [expected],
    );
    await worker().runOnce();
  }
  throw new Error("CUSTODY_JOB_DID_NOT_CONVERGE");
}

try {
  const phase = process.argv[2];
  if (phase === "prepare") {
    await pool.query(
      `UPDATE domains SET status='active',verification_status='verified',mail_activation='local-lab',
      revalidation_state='current',revalidation_grace_expires_at=NULL WHERE id=$1`,
      [domain],
    );
    await updateMailbox(owner, org, mailbox, { action: "resume" });
    await applyLatest();
    const snapshot = await latest();
    const observation = await adapter.inspect(
      queue.target(snapshot),
      AbortSignal.timeout(35_000),
    );
    assert.deepEqual(observation, {
      status: "active",
      quotaMb: Number(snapshot.quota_mb),
      inboundPolicy: "accept",
    });
    console.log(JSON.stringify({ phase, passed: true, observation }));
  } else if (phase === "custody") {
    const queued = await transaction(async (db) => {
      await db.query(
        `UPDATE domains SET verification_status='failed',mail_activation='disabled',
        revalidation_state='failed',revalidation_grace_expires_at=NOW() WHERE id=$1`,
        [domain],
      );
      const expected = Number(
        (
          await db.query(
            `SELECT COUNT(*)::int AS count FROM mailboxes WHERE domain_id=$1
            AND (desired_status<>'suspended' OR desired_inbound_policy<>'defer')`,
            [domain],
          )
        ).rows[0].count,
      );
      return {
        expected,
        actual: await queueFailedDomainCustody(db, domain),
      };
    });
    assert.ok(queued.expected > 0);
    assert.equal(queued.actual, queued.expected);
    const snapshot = await latest();
    assert.equal(snapshot.operation, "domain_custody");
    assert.equal(snapshot.desired_status, "suspended");
    assert.equal(snapshot.inbound_policy, "defer");
    await applyLatest();
    const applied = await latest();
    const observation = await adapter.inspect(
      queue.target(applied),
      AbortSignal.timeout(35_000),
    );
    assert.deepEqual(observation, {
      status: "suspended",
      quotaMb: Number(applied.quota_mb),
      inboundPolicy: "defer",
    });
    console.log(JSON.stringify({ phase, passed: true, observation }));
  } else throw new Error("UNKNOWN_CUSTODY_PHASE");
} catch (error) {
  console.error(
    JSON.stringify({
      phase: process.argv[2],
      passed: false,
      code: error instanceof Error ? error.message : "CUSTODY_CONFORMANCE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
