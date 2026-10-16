import assert from "node:assert/strict";
import pool from "../config/database.js";
import { DmsUsageLabAdapter } from "../adapters/dms-usage-lab.adapter.js";
import {
  runUsageOnce,
  usagePresentation,
} from "../services/mailbox-usage.service.js";
import { rpc } from "./rpc.js";

const organizationId = "11111111-1111-4111-8111-111111111111",
  mailboxId = "55555555-5555-4555-8555-555555555555",
  address = "pilot@tenant-a.lab.invalid",
  target = { organizationId, mailboxId, address };
const checks: string[] = [];
let stage = "direct-usage";
try {
  const phase = process.argv[2] ?? "baseline",
    direct = await rpc("/v1/usage", target);
  assert.equal(direct.status, 200);
  assert.ok(
    Number.isSafeInteger(direct.body.usageBytes) &&
      Number(direct.body.usageBytes) > 0,
  );
  assert.ok(
    Number.isSafeInteger(direct.body.messageCount) &&
      Number(direct.body.messageCount) > 0,
  );
  checks.push("native-dovecot-quota-and-message-usage");
  stage = "authorization";
  assert.equal(
    (
      await rpc("/v1/usage", {
        ...target,
        organizationId: "22222222-2222-4222-8222-222222222222",
      })
    ).status,
    403,
  );
  assert.equal((await rpc("/v1/usage", target, false)).status, 401);
  checks.push("usage-target-and-peer-authorization");
  if (phase === "baseline") {
    stage = "queue-setup";
    await pool.query("DELETE FROM mailbox_usage_requests WHERE mailbox_id=$1", [
      mailboxId,
    ]);
    await pool.query(
      "UPDATE mailboxes SET observed_usage_bytes=NULL,observed_message_count=NULL,usage_observed_at=NULL,usage_last_error_code=NULL WHERE id=$1",
      [mailboxId],
    );
    await pool.query(
      "INSERT INTO mailbox_usage_requests(mailbox_id) VALUES($1)",
      [mailboxId],
    );
    stage = "worker-read";
    assert.equal(
      await runUsageOnce(new DmsUsageLabAdapter(), {
        allowLab: true,
        organizationId,
        leaseMs: 60_000,
        timeoutMs: 30_000,
      }),
      "completed",
    );
    stage = "database-observation";
    const row = (
      await pool.query(
        "SELECT observed_usage_bytes,observed_message_count,usage_observed_at,usage_last_error_code FROM mailboxes WHERE id=$1",
        [mailboxId],
      )
    ).rows[0];
    assert.equal(
      Number(row.observed_usage_bytes),
      Number(direct.body.usageBytes),
    );
    assert.equal(
      Number(row.observed_message_count),
      Number(direct.body.messageCount),
    );
    assert.equal(usagePresentation(row).usageState, "fresh");
    checks.push("durable-usage-worker-observation");
  } else {
    stage = "restart-comparison";
    const row = (
      await pool.query(
        "SELECT observed_usage_bytes,observed_message_count,usage_observed_at FROM mailboxes WHERE id=$1",
        [mailboxId],
      )
    ).rows[0];
    assert.equal(
      Number(row.observed_usage_bytes),
      Number(direct.body.usageBytes),
    );
    assert.equal(
      Number(row.observed_message_count),
      Number(direct.body.messageCount),
    );
    checks.push("usage-persists-and-matches-after-provider-restart");
  }
  console.log(
    JSON.stringify({
      passed: true,
      phase,
      checks,
      usageBytes: Number(direct.body.usageBytes),
      messageCount: Number(direct.body.messageCount),
      syntheticOnly: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "USAGE_CONFORMANCE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
