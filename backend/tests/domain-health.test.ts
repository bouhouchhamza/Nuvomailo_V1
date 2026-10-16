import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { health, lifecycle } from "../src/services/domain-health.service.js";
import { createMailbox } from "../src/services/mailbox.service.js";
const owner = randomUUID(),
  other = randomUUID();
let org: string, id: string;
after(async () => {
  if (org) await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other],
  ]);
  await pool.end();
});
test("DNS diagnostics are resolver-controlled and ownership is separate from activation; retained domains cannot create mailboxes", async () => {
  for (const user of [owner, other])
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",
      [user, `${user}@example.test`],
    );
  org = (
    await createOrganization(owner, {
      name: "Domain health",
      slug: randomUUID(),
    })
  ).id;
  id = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,verification_status) VALUES($1,$2,'synthetic','verified') RETURNING id",
      [org, `${org}.example.test`],
    )
  ).rows[0]!.id;
  const resolver = {
    mx: async () => [{ exchange: "mail.lab.invalid", priority: 10 }],
    txt: async (name: string) =>
      name.startsWith("_dmarc.")
        ? [["v=DMARC1; p=none"]]
        : name.startsWith("mail._domainkey.")
          ? [["v=DKIM1; p=synthetic"]]
          : [["v=spf1 -all"]],
  };
  const report = await health(owner, org, id, resolver);
  assert.equal(report.ownershipVerified, true);
  assert.equal(report.mailReady, false);
  assert.equal(report.mailActivation, "disabled");
  assert.equal(report.spf.singleRecord, true);
  await assert.rejects(health(other, org, id, resolver));
  await lifecycle(owner, org, id, { action: "retain" });
  await assert.rejects(
    createMailbox(owner, org, {
      domainId: id,
      localPart: "retained",
      quotaMb: 100,
    }),
  );
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS n FROM domains WHERE id=$1", [
        id,
      ])
    ).rows[0]!.n,
    1,
  );
  await lifecycle(owner, org, id, { action: "resume" });
  await pool.query(
    `UPDATE domains SET revalidation_state='warning',ownership_revalidated_at=NOW(),
    revalidation_last_attempt_at=NOW(),revalidation_failures=3,revalidation_grace_expires_at=NOW()+INTERVAL '1 day'
    WHERE id=$1`,
    [id],
  );
  await lifecycle(owner, org, id, { action: "reverify" });
  const reset = (
    await pool.query(
      `SELECT verification_status,verified_at,revalidation_state,ownership_revalidated_at,
      revalidation_last_attempt_at,revalidation_failures,revalidation_grace_expires_at
      FROM domains WHERE id=$1`,
      [id],
    )
  ).rows[0]!;
  assert.equal(reset.verification_status, "pending");
  assert.equal(reset.verified_at, null);
  assert.equal(reset.revalidation_state, "due");
  assert.equal(reset.ownership_revalidated_at, null);
  assert.equal(reset.revalidation_last_attempt_at, null);
  assert.equal(reset.revalidation_failures, 0);
  assert.equal(reset.revalidation_grace_expires_at, null);
  const next = await health(owner, org, id, {
    mx: async () => {
      throw new Error("synthetic DNS failure");
    },
    txt: async () => [],
  });
  assert.equal(next.ownershipVerified, false);
  assert.equal(next.mx.error, "DNS_LOOKUP_FAILED");
  assert.equal(next.mailReady, false);
});
