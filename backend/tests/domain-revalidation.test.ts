import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { registerUser, loginUser } from "../src/services/auth.service.js";
import { digest } from "../src/services/session.service.js";
import { createOrganization } from "../src/services/tenant.service.js";
import {
  createDomain,
  verifyDomain,
  revalidateDomain,
  releaseEmptyDomain,
} from "../src/services/domain.service.js";
const password = "SyntheticDomainRevalidation123!",
  email = `${randomUUID()}@example.test`;
let actor = "",
  otherActor = "",
  org = "",
  otherOrg = "";
after(async () => {
  if (otherOrg)
    await pool.query("DELETE FROM organizations WHERE id=$1", [otherOrg]);
  if (org) {
    await pool.query(
      "DELETE FROM released_domain_claims WHERE organization_id=$1",
      [org],
    );
    await pool.query(
      "DELETE FROM mailboxes WHERE domain_id IN(SELECT id FROM domains WHERE organization_id=$1)",
      [org],
    );
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  }
  if (actor || otherActor)
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
      [actor, otherActor].filter(Boolean),
    ]);
  await pool.end();
});
test("ownership revalidation warns before grace expiry and empty never-activated release is reauthenticated and reusable", async () => {
  actor = (await registerUser({ email, password })).id;
  await pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
    actor,
  ]);
  const login = await loginUser({ email, password });
  const session = (
    await pool.query("SELECT session_id FROM refresh_tokens WHERE digest=$1", [
      digest(login.refreshToken),
    ])
  ).rows[0].session_id;
  org = (
    await createOrganization(actor, {
      name: "Domain revalidation",
      slug: randomUUID(),
    })
  ).id;
  otherActor = (
    await registerUser({
      email: `${randomUUID()}@example.test`,
      password,
    })
  ).id;
  otherOrg = (
    await createOrganization(otherActor, {
      name: "Other domain owner",
      slug: randomUUID(),
    })
  ).id;
  const created = await createDomain(actor, org, {
    name: `${randomUUID()}.example.test`,
  });
  const answer = [[created.dnsChallenge.value]];
  const verified = await verifyDomain(
    actor,
    org,
    created.id,
    async () => answer,
  );
  assert.equal(verified.revalidation_state, "current");
  const warning = await revalidateDomain(
    actor,
    org,
    created.id,
    async () => [],
  );
  assert.equal(warning.revalidation_state, "warning");
  assert.equal(warning.ownershipRetained, true);
  assert.equal(warning.mailPolicyChanged, false);
  const warningGrace = new Date(
    warning.revalidation_grace_expires_at!,
  ).getTime();
  assert.ok(warningGrace - Date.now() > 29 * 24 * 60 * 60 * 1000);
  assert.ok(warningGrace - Date.now() <= 30 * 24 * 60 * 60 * 1000);
  await assert.rejects(
    revalidateDomain(otherActor, otherOrg, created.id, async () => answer),
    (error: unknown) => (error as { status?: number }).status === 404,
  );
  await assert.rejects(
    revalidateDomain(actor, org, created.id, async () => answer),
    (error: unknown) => (error as { status?: number }).status === 429,
  );
  await pool.query(
    "UPDATE domains SET revalidation_last_attempt_at=NOW()-INTERVAL '61 seconds' WHERE id=$1",
    [created.id],
  );
  const restored = await revalidateDomain(
    actor,
    org,
    created.id,
    async () => answer,
  );
  assert.equal(restored.revalidation_state, "current");
  assert.equal(restored.revalidation_failures, 0);
  await pool.query(
    "UPDATE domains SET revalidation_last_attempt_at=NOW()-INTERVAL '61 seconds' WHERE id=$1",
    [created.id],
  );
  let finishSlowLookup!: (records: string[][]) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const slowRecords = new Promise<string[][]>((resolve) => {
    finishSlowLookup = resolve;
  });
  const staleAttempt = revalidateDomain(actor, org, created.id, async () => {
    lookupStarted();
    return slowRecords;
  });
  await started;
  await pool.query(
    "UPDATE domains SET revalidation_last_attempt_at=NOW()-INTERVAL '61 seconds' WHERE id=$1",
    [created.id],
  );
  assert.equal(
    (await revalidateDomain(actor, org, created.id, async () => []))
      .revalidation_state,
    "warning",
  );
  finishSlowLookup(answer);
  await assert.rejects(
    staleAttempt,
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  await pool.query(
    "UPDATE domains SET revalidation_last_attempt_at=NOW()-INTERVAL '61 seconds',revalidation_grace_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [created.id],
  );
  const failed = await revalidateDomain(actor, org, created.id, async () => []);
  assert.equal(failed.revalidation_state, "failed");
  assert.equal(failed.ownershipRetained, false);
  assert.equal(failed.mail_activation, "disabled");
  await assert.rejects(
    releaseEmptyDomain(otherActor, randomUUID(), org, created.id, {
      confirmName: created.name,
      dashboardPassword: password,
      reason: "test-claim",
    }),
    (error: unknown) => (error as { status?: number }).status === 404,
  );
  await assert.rejects(
    releaseEmptyDomain(actor, randomUUID(), org, created.id, {
      confirmName: created.name,
      dashboardPassword: password,
      reason: "test-claim",
    }),
    (error: unknown) => (error as { status?: number }).status === 403,
  );
  await assert.rejects(
    releaseEmptyDomain(actor, session, org, created.id, {
      confirmName: created.name,
      dashboardPassword: "wrong",
      reason: "test-claim",
    }),
  );
  const released = await releaseEmptyDomain(actor, session, org, created.id, {
    confirmName: created.name,
    dashboardPassword: password,
    reason: "test-claim",
  });
  assert.equal(released.nameReusable, true);
  assert.equal(released.dnsChanged, false);
  assert.equal(released.mailDataDeleted, false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM domains WHERE id=$1",
        [created.id],
      )
    ).rows[0].count,
    0,
  );
  const history = (
    await pool.query(
      "SELECT name_digest FROM released_domain_claims WHERE original_domain_id=$1",
      [created.id],
    )
  ).rows[0];
  assert.match(history.name_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(history).includes(created.name), false);
  const reused = await createDomain(actor, org, { name: created.name });
  assert.equal(reused.name, created.name);
  await pool.query(
    "UPDATE domains SET verification_status='verified' WHERE id=$1",
    [reused.id],
  );
  await pool.query(
    "INSERT INTO mailboxes(domain_id,local_part) VALUES($1,'reserved')",
    [reused.id],
  );
  await assert.rejects(
    releaseEmptyDomain(actor, session, org, reused.id, {
      confirmName: reused.name,
      dashboardPassword: password,
      reason: "test-claim",
    }),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  const custodyDomain = await createDomain(actor, org, {
    name: `${randomUUID()}.example.test`,
  });
  await verifyDomain(actor, org, custodyDomain.id, async () => [
    [custodyDomain.dnsChallenge.value],
  ]);
  const custodyMailbox = (
    await pool.query(
      "INSERT INTO mailboxes(domain_id,local_part) VALUES($1,'manual-custody') RETURNING id",
      [custodyDomain.id],
    )
  ).rows[0];
  await revalidateDomain(actor, org, custodyDomain.id, async () => []);
  await pool.query(
    `UPDATE domains SET revalidation_last_attempt_at=NOW()-INTERVAL '61 seconds',
    revalidation_grace_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,
    [custodyDomain.id],
  );
  const custodyFailure = await revalidateDomain(
    actor,
    org,
    custodyDomain.id,
    async () => [],
  );
  assert.equal(custodyFailure.mailPolicyChanged, false);
  assert.equal(custodyFailure.mailPolicyChangeQueued, true);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT m.desired_status,m.desired_inbound_policy,p.operation,p.inbound_policy
        FROM mailboxes m JOIN provisioning_requests p ON p.mailbox_id=m.id
        WHERE m.id=$1 ORDER BY p.created_at DESC LIMIT 1`,
        [custodyMailbox.id],
      )
    ).rows[0],
    {
      desired_status: "suspended",
      desired_inbound_policy: "defer",
      operation: "domain_custody",
      inbound_policy: "defer",
    },
  );
  const activated = await createDomain(actor, org, {
    name: `${randomUUID()}.example.test`,
  });
  await pool.query(
    "UPDATE domains SET mail_activation='local-lab' WHERE id=$1",
    [activated.id],
  );
  await pool.query(
    "UPDATE domains SET mail_activation='disabled' WHERE id=$1",
    [activated.id],
  );
  await assert.rejects(
    releaseEmptyDomain(actor, session, org, activated.id, {
      confirmName: activated.name,
      dashboardPassword: password,
      reason: "test-claim",
    }),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  const routed = await createDomain(actor, org, {
    name: `${randomUUID()}.example.test`,
  });
  await pool.query("UPDATE domains SET routing_generation=1 WHERE id=$1", [
    routed.id,
  ]);
  await assert.rejects(
    releaseEmptyDomain(actor, session, org, routed.id, {
      confirmName: routed.name,
      dashboardPassword: password,
      reason: "test-claim",
    }),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM audit_events WHERE organization_id=$1 AND action='domain.released'",
          [org],
        )
      ).rows[0].count,
    ),
    1,
  );
});
