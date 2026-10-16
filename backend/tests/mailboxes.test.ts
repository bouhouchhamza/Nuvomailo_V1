import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import app from "../src/app.js";
import pool from "../src/config/database.js";
import { issueToken } from "../src/middlewares/auth.js";
const owner = randomUUID(),
  other = randomUUID(),
  member = randomUUID(),
  org = randomUUID(),
  domain = randomUUID(),
  otherOrg = randomUUID(),
  otherDomain = randomUUID();
const auth = (id: string) => `Bearer ${issueToken(id)}`;
const path = `/api/organizations/${org}/mailboxes`;
after(async () => {
  await pool.query("DELETE FROM mailboxes WHERE domain_id=$1", [domain]);
  await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM organizations WHERE id=$1", [otherOrg]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other, member],
  ]);
  await pool.end();
});
test("verified-domain gate, mailbox isolation, quotas and durable pending provisioning", async () => {
  for (const id of [owner, other, member])
    await pool.query(
      "INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)",
      [id, `${id}@example.test`, "test-only"],
    );
  await pool.query(
    "INSERT INTO organizations (id,name,slug) VALUES ($1,$2,$3)",
    [org, "Mailbox test", org],
  );
  await pool.query(
    "INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$3,'owner'),($2,$3,'member')",
    [owner, member, org],
  );
  await pool.query(
    "INSERT INTO domains (id,organization_id,name,verification_token) VALUES ($1,$2,$3,$4)",
    [domain, org, `${domain}.example.com`, "test-challenge"],
  );
  await pool.query("INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)", [
    otherOrg,
    "Other tenant",
    otherOrg,
  ]);
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'owner')",
    [other, otherOrg],
  );
  await pool.query(
    "INSERT INTO domains(id,organization_id,name,verification_token,verification_status) VALUES($1,$2,$3,'test','verified')",
    [otherDomain, otherOrg, `${otherDomain}.example.test`],
  );
  const create = (body: Record<string, unknown>, id = owner) =>
    request(app).post(path).set("Authorization", auth(id)).send(body);
  const body = { domainId: domain, localPart: "pilot", quotaMb: 100 };
  assert.equal((await create(body)).status, 422);
  assert.equal((await create({ ...body, domainId: otherDomain })).status, 422);
  assert.equal(
    (
      await request(app)
        .post(`/api/organizations/${otherOrg}/mailboxes`)
        .set("Authorization", auth(owner))
        .send({ ...body, domainId: otherDomain })
    ).status,
    404,
  );
  await pool.query(
    "UPDATE domains SET verification_status='verified',verified_at=NOW() WHERE id=$1",
    [domain],
  );
  assert.equal((await create({ ...body, quotaMb: 500 })).status, 400);
  assert.equal(
    (await create({ ...body, localPart: "bad@address" })).status,
    400,
  );
  assert.equal(
    (await create({ ...body, password: "do-not-store" })).status,
    400,
  );
  assert.equal((await create(body, member)).status, 403);
  const created = await create(body);
  assert.equal(created.status, 202);
  assert.equal(created.body.address, `pilot@${domain}.example.com`);
  assert.equal(created.body.liveMailAvailable, false);
  assert.equal(created.body.provisioning_status, "pending_provisioning");
  assert.equal((await create({ ...body, localPart: "PILOT" })).status, 409);
  assert.equal(
    (await request(app).get(path).set("Authorization", auth(other))).status,
    404,
  );
  const item = `${path}/${created.body.id}`;
  assert.equal(
    (await request(app).get(item).set("Authorization", auth(other))).status,
    404,
  );
  assert.equal(
    (await request(app).get(item).set("Authorization", auth(member))).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .patch(item)
        .set("Authorization", auth(member))
        .send({ quotaMb: 200 })
    ).status,
    403,
  );
  const update = await request(app)
    .patch(item)
    .set("Authorization", auth(owner))
    .send({ quotaMb: 200 });
  assert.equal(update.status, 202);
  assert.equal(update.body.quota_mb, 200);
  const suspend = await request(app)
    .patch(item)
    .set("Authorization", auth(owner))
    .send({ action: "suspend" });
  assert.equal(suspend.status, 202);
  assert.equal(suspend.body.provisioning_status, "pending_provisioning");
  const jobs = (
    await pool.query(
      "SELECT operation,state FROM provisioning_requests WHERE mailbox_id=$1 ORDER BY created_at",
      [created.body.id],
    )
  ).rows;
  assert.deepEqual(
    jobs.map((j) => j.operation),
    ["create", "set_quota", "suspend"],
  );
  assert.ok(jobs.every((j) => j.state === "pending"));
  const retention = `${item}/retention`;
  assert.equal(
    (
      await request(app)
        .post(retention)
        .set("Authorization", auth(member))
        .send({ action: "retain" })
    ).status,
    403,
  );
  const retained = await request(app)
    .post(retention)
    .set("Authorization", auth(owner))
    .send({ action: "retain" });
  assert.equal(retained.status, 202);
  assert.equal(retained.body.retained, true);
  assert.equal(retained.body.providerApplied, false);
  assert.equal(
    (
      await request(app)
        .post(retention)
        .set("Authorization", auth(owner))
        .send({ action: "retain" })
    ).body.changed,
    false,
  );
  assert.equal(
    (
      await request(app)
        .patch(item)
        .set("Authorization", auth(owner))
        .send({ action: "resume" })
    ).status,
    409,
  );
  await assert.rejects(
    pool.query("UPDATE mailboxes SET desired_status='active' WHERE id=$1", [
      created.body.id,
    ]),
  );
  const restored = await request(app)
    .post(retention)
    .set("Authorization", auth(owner))
    .send({ action: "restore" });
  assert.equal(restored.status, 202);
  assert.equal(restored.body.retained, false);
  assert.equal(
    (
      await pool.query(
        "SELECT retained_at,desired_status FROM mailboxes WHERE id=$1",
        [created.body.id],
      )
    ).rows[0].desired_status,
    "active",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM provisioning_requests WHERE mailbox_id=$1",
          [created.body.id],
        )
      ).rows[0].count,
    ),
    5,
  );
  // Foreign domain IDs cannot bypass organization scope, even for an owner.
  assert.equal(
    (await create({ ...body, domainId: randomUUID(), localPart: "another" }))
      .status,
    422,
  );
});
