import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import app from "../src/app.js";
import pool from "../src/config/database.js";
import { issueToken } from "../src/middlewares/auth.js";
import {
  UsageProviderError,
  type MailboxUsageReader,
} from "../src/services/mailbox-usage.adapter.js";
import {
  requestRefresh,
  runUsageOnce,
  scheduleUsage,
  status,
  refreshUsageRollups,
  organizationUsage,
} from "../src/services/mailbox-usage.service.js";

const owner = randomUUID(),
  member = randomUUID(),
  outsider = randomUUID(),
  org = randomUUID(),
  domain = randomUUID(),
  box = randomUUID();
const base = `/api/organizations/${org}/mailboxes/${box}`,
  auth = (id: string) => `Bearer ${issueToken(id)}`;
after(async () => {
  await pool.query("DELETE FROM mailboxes WHERE id=$1", [box]);
  await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, member, outsider],
  ]);
  await pool.end();
});

test("usage refresh is scoped, deduplicated, leased and exposes unknown/fresh/stale without fabricating data", async () => {
  for (const id of [owner, member, outsider])
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test')",
      [id, `${id}@example.test`],
    );
  await pool.query(
    "INSERT INTO organizations(id,name,slug) VALUES($1,'Usage test',$2)",
    [org, org],
  );
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$3,'owner'),($2,$3,'member')",
    [owner, member, org],
  );
  await pool.query(
    "INSERT INTO domains(id,organization_id,name,verification_token,verification_status,mail_activation) VALUES($1,$2,$3,'test','verified','local-lab')",
    [domain, org, `${domain}.example.test`],
  );
  await pool.query(
    "INSERT INTO mailboxes(id,domain_id,local_part) VALUES($1,$2,'usage')",
    [box, domain],
  );
  assert.equal((await status(owner, org, box)).usageState, "unknown");
  assert.equal(
    (
      await request(app)
        .get(`${base}/usage`)
        .set("Authorization", auth(outsider))
    ).status,
    404,
  );
  assert.equal(
    (
      await request(app)
        .post(`${base}/usage-refresh`)
        .set("Authorization", auth(member))
    ).status,
    403,
  );
  const first = await requestRefresh(owner, org, box),
    duplicate = await requestRefresh(owner, org, box);
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(first.id, duplicate.id);
  let reads = 0;
  const reader: MailboxUsageReader = {
    mode: "local-lab",
    read: async () => {
      reads++;
      return { usageBytes: 4096, messageCount: 3 };
    },
  };
  const concurrent = await Promise.all([
    runUsageOnce(reader, { allowLab: true, organizationId: org }),
    runUsageOnce(reader, { allowLab: true, organizationId: org }),
  ]);
  assert.equal(concurrent.filter((value) => value === "completed").length, 1);
  assert.equal(reads, 1);
  const fresh = await status(owner, org, box);
  assert.equal(fresh.usageState, "fresh");
  assert.equal(fresh.usageBytes, 4096);
  assert.equal(fresh.messageCount, 3);
  assert.equal(await refreshUsageRollups(10, org), 1);
  const aggregate = await organizationUsage(owner, org);
  assert.equal(aggregate.rollupState, "fresh");
  assert.equal(aggregate.coverageComplete, true);
  assert.equal(aggregate.observedUsageBytes, "4096");
  assert.equal(aggregate.observedMessageCount, "3");
  assert.equal(aggregate.billingEligible, false);
  assert.equal(aggregate.billingReason, "pricing-not-approved");
  assert.equal(
    (
      await request(app)
        .get(`/api/organizations/${org}/usage-summary`)
        .set("Authorization", auth(owner))
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .get(`/api/organizations/${org}/usage-summary`)
        .set("Authorization", auth(outsider))
    ).status,
    404,
  );
  await pool.query(
    "UPDATE mailboxes SET usage_observed_at=NOW()-INTERVAL '16 minutes' WHERE id=$1",
    [box],
  );
  assert.equal((await status(owner, org, box)).usageState, "stale");
  await refreshUsageRollups(10, org);
  const staleAggregate = await organizationUsage(owner, org);
  assert.equal(staleAggregate.coverageComplete, false);
  assert.equal(staleAggregate.staleMailboxCount, 1);
  assert.equal(staleAggregate.billingReason, "incomplete-observations");
  const scheduled = await Promise.all([
    scheduleUsage(15 * 60_000, 10, org),
    scheduleUsage(15 * 60_000, 10, org),
  ]);
  assert.equal(
    scheduled.reduce((sum, value) => sum + value, 0),
    1,
  );
  assert.equal(
    await runUsageOnce(
      {
        mode: "local-lab",
        read: async () => {
          throw new UsageProviderError("PROVIDER_REJECTED", false);
        },
      },
      { allowLab: true, organizationId: org },
    ),
    "failed",
  );
  const failed = await status(owner, org, box);
  assert.equal(failed.usageBytes, 4096);
  assert.equal(failed.usageLastErrorCode, "PROVIDER_REJECTED");
  await requestRefresh(owner, org, box);
  assert.equal(
    await runUsageOnce(
      {
        mode: "local-lab",
        read: async () => {
          throw new UsageProviderError("PROVIDER_UNAVAILABLE", true);
        },
      },
      { allowLab: true, organizationId: org },
    ),
    "retry",
  );
  await pool.query(
    "UPDATE mailbox_usage_requests SET available_at=NOW()-INTERVAL '1 second' WHERE mailbox_id=$1 AND state='pending'",
    [box],
  );
  assert.equal(
    await runUsageOnce(
      { mode: "local-lab", read: async () => new Promise(() => {}) },
      { allowLab: true, organizationId: org, leaseMs: 2000, timeoutMs: 10 },
    ),
    "retry",
  );
  await pool.query(
    "UPDATE mailbox_usage_requests SET available_at=NOW()-INTERVAL '1 second' WHERE mailbox_id=$1 AND state='pending'",
    [box],
  );
  assert.equal(
    await runUsageOnce(
      {
        mode: "local-lab",
        read: async () => {
          await pool.query(
            "UPDATE mailbox_usage_requests SET lease_token=$2 WHERE mailbox_id=$1 AND state='processing'",
            [box, randomUUID()],
          );
          return { usageBytes: 8192, messageCount: 4 };
        },
      },
      { allowLab: true, organizationId: org },
    ),
    "stale",
  );
  assert.equal((await status(owner, org, box)).usageBytes, 4096);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM audit_events WHERE organization_id=$1 AND action='mailbox.usage_observed'",
          [org],
        )
      ).rows[0].count,
    ),
    1,
  );
  await pool.query(
    "UPDATE domains SET mail_activation='disabled' WHERE id=$1",
    [domain],
  );
  await assert.rejects(
    requestRefresh(owner, org, box),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
});
