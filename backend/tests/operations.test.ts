import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import app from "../src/app.js";
import pool from "../src/config/database.js";
import { issueToken } from "../src/middlewares/auth.js";
import { tenantWrite } from "../src/services/tenant-context.js";
import { appendAudit } from "../src/repositories/audit.repository.js";
import { createMailbox } from "../src/services/mailbox.service.js";
import { scheduleReconciliations } from "../src/repositories/operations.repository.js";
import { createDomain, verifyDomain } from "../src/services/domain.service.js";
import * as mailboxRepo from "../src/repositories/mailbox.repository.js";
const owner = randomUUID(),
  member = randomUUID(),
  outsider = randomUUID(),
  org = randomUUID(),
  domain = randomUUID();
const auth = (id: string) => `Bearer ${issueToken(id)}`;
const base = `/api/organizations/${org}`;
after(async () => {
  await pool.query("DELETE FROM mailboxes WHERE domain_id=$1", [domain]);
  await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, member, outsider],
  ]);
  await pool.end();
});
test("operational boundaries, pagination, revocation lock, rollback and reconciliation scheduling", async () => {
  for (const id of [owner, member, outsider])
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
      [id, `${id}@example.test`, "test"],
    );
  await pool.query("INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)", [
    org,
    "Operations",
    org,
  ]);
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$3,'owner'),($2,$3,'member')",
    [owner, member, org],
  );
  await pool.query(
    "INSERT INTO domains(id,organization_id,name,verification_token,verification_status) VALUES($1,$2,$3,'test','verified')",
    [domain, org, `${domain}.example.test`],
  );
  const box = await createMailbox(owner, org, {
    domainId: domain,
    localPart: "operations",
  });
  for (const route of ["audit-events", "provisioning-requests"]) {
    assert.equal(
      (
        await request(app)
          .get(`${base}/${route}`)
          .set("Authorization", auth(outsider))
      ).status,
      404,
    );
    assert.equal(
      (
        await request(app)
          .get(`${base}/${route}`)
          .set("Authorization", auth(member))
      ).status,
      403,
    );
    const page = await request(app)
      .get(`${base}/${route}?limit=1`)
      .set("Authorization", auth(owner));
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 1);
    assert.equal(JSON.stringify(page.body).includes("lease_token"), false);
    assert.equal(
      (
        await request(app)
          .get(`${base}/${route}?limit=101`)
          .set("Authorization", auth(owner))
      ).status,
      400,
    );
  }
  const job = (
    await pool.query(
      "SELECT id FROM provisioning_requests WHERE mailbox_id=$1",
      [box.id],
    )
  ).rows[0]!;
  for (const id of [outsider, member]) {
    assert.equal(
      (
        await request(app)
          .post(`${base}/provisioning-requests/${job.id}/retry`)
          .set("Authorization", auth(id))
      ).status,
      id === member ? 403 : 404,
    );
    assert.equal(
      (
        await request(app)
          .post(`${base}/mailboxes/${box.id}/reconcile`)
          .set("Authorization", auth(id))
      ).status,
      id === member ? 403 : 404,
    );
  }
  assert.equal(
    (
      await request(app)
        .post(`${base}/provisioning-requests/${job.id}/retry`)
        .set("Authorization", auth(owner))
    ).status,
    409,
  );
  assert.equal(
    (
      await request(app)
        .post(`${base}/mailboxes/${box.id}/reconcile`)
        .set("Authorization", auth(owner))
    ).status,
    409,
  );
  // All changes and their audits roll back together.
  const before = (
    await pool.query(
      "SELECT COUNT(*)::integer AS count FROM audit_events WHERE organization_id=$1",
      [org],
    )
  ).rows[0]!.count;
  await assert.rejects(
    tenantWrite(owner, org, "manage", async (client) => {
      await client.query(
        "UPDATE organizations SET name='Should roll back' WHERE id=$1",
        [org],
      );
      await appendAudit(client, {
        organizationId: org,
        actorId: owner,
        action: "test.rollback",
        resourceId: org,
      });
      throw new Error("rollback");
    }),
  );
  assert.equal(
    (await pool.query("SELECT name FROM organizations WHERE id=$1", [org]))
      .rows[0]!.name,
    "Operations",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::integer AS count FROM audit_events WHERE organization_id=$1",
        [org],
      )
    ).rows[0]!.count,
    before,
  );
  await assert.rejects(
    tenantWrite(owner, org, "manage", async (client) => {
      const result = await mailboxRepo.create(
        client,
        org,
        domain,
        "rolled-back",
        100,
      );
      assert.ok(result);
      await appendAudit(client, {
        organizationId: org,
        actorId: owner,
        action: "test.mailbox_rollback",
        resourceId: result.mailbox.id,
      });
      throw new Error("abort after resource, request and audit");
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM mailboxes WHERE domain_id=$1 AND local_part='rolled-back'",
        [domain],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::integer AS count FROM audit_events WHERE organization_id=$1",
        [org],
      )
    ).rows[0]!.count,
    before,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::integer AS count FROM provisioning_requests p JOIN mailboxes m ON m.id=p.mailbox_id WHERE m.domain_id=$1",
        [domain],
      )
    ).rows[0]!.count,
    1,
  );
  // Membership revocation cannot pass an admitted write's shared lock.
  const revoker = await pool.connect();
  try {
    await revoker.query("SET lock_timeout='100ms'");
    await tenantWrite(member, org, "read", async () => {
      await assert.rejects(
        revoker.query(
          "DELETE FROM memberships WHERE user_id=$1 AND organization_id=$2",
          [member, org],
        ),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
    });
    await revoker.query(
      "DELETE FROM memberships WHERE user_id=$1 AND organization_id=$2",
      [member, org],
    );
    await assert.rejects(
      tenantWrite(member, org, "read", async () => true),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  } finally {
    await revoker.query("RESET lock_timeout");
    revoker.release();
  }
  // A DNS result arriving after an admin's demotion cannot authorize a mutation.
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'admin')",
    [member, org],
  );
  const pending = await createDomain(owner, org, {
    name: `dns-race-${org}.example.test`,
  });
  await assert.rejects(
    verifyDomain(member, org, pending.id, async () => {
      await pool.query(
        "UPDATE memberships SET role='member' WHERE user_id=$1 AND organization_id=$2",
        [member, org],
      );
      return [[pending.dnsChallenge.value]];
    }),
    (error: unknown) => (error as { status?: number }).status === 403,
  );
  assert.equal(
    (
      await pool.query("SELECT verification_status FROM domains WHERE id=$1", [
        pending.id,
      ])
    ).rows[0]!.verification_status,
    "pending",
  );
  // Scheduler deduplicates against any outstanding work and uses row locks across schedulers.
  assert.equal(await scheduleReconciliations(0, 50, org), 0);
  await pool.query(
    "UPDATE provisioning_requests SET state='completed' WHERE mailbox_id=$1",
    [box.id],
  );
  await pool.query(
    "UPDATE mailboxes SET applied_revision=desired_revision,observed_at=NOW()-INTERVAL '2 hours',observed_status='active',observed_quota_mb=100 WHERE id=$1",
    [box.id],
  );
  const results = await Promise.all([
    scheduleReconciliations(3600000, 50, org),
    scheduleReconciliations(3600000, 50, org),
  ]);
  assert.equal(
    results.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::integer AS count FROM provisioning_requests WHERE mailbox_id=$1 AND operation='reconcile'",
        [box.id],
      )
    ).rows[0]!.count,
    1,
  );
  // Audit cursor is scoped and stable, even while newer events arrive.
  const first = await request(app)
    .get(`${base}/audit-events?limit=1`)
    .set("Authorization", auth(owner));
  assert.ok(first.body.nextCursor);
  const second = await request(app)
    .get(`${base}/audit-events?limit=1&before=${first.body.nextCursor}`)
    .set("Authorization", auth(owner));
  assert.notEqual(first.body.items[0].id, second.body.items[0].id);
  const readiness = await request(app)
    .get("/api/ready")
    .set("X-Request-Id", "untrusted-header");
  assert.equal(readiness.status, 200);
  assert.equal(readiness.body.mailReady, false);
  assert.notEqual(readiness.headers["x-request-id"], "untrusted-header");
});
