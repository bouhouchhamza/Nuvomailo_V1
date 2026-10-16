import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import pool from "../src/config/database.js";
import { issueToken } from "../src/middlewares/auth.js";
const owner = randomUUID(),
  other = randomUUID(),
  org = randomUUID();
let answers: string[][] = [];
const app = createApp({ resolveTxt: async () => answers });
const auth = `Bearer ${issueToken(owner)}`;
const path = `/api/organizations/${org}/domains`;
after(async () => {
  await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other],
  ]);
  await pool.end();
});
test("DNS challenge requires server lookup, isolates tenants, throttles attempts and renews expired challenges", async () => {
  for (const id of [owner, other])
    await pool.query(
      "INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)",
      [id, `${id}@example.test`, "test-only"],
    );
  await pool.query(
    "INSERT INTO organizations (id,name,slug) VALUES ($1,$2,$3)",
    [org, "DNS test", org],
  );
  await pool.query(
    "INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'owner')",
    [owner, org],
  );
  assert.equal(
    (
      await request(app)
        .post(path)
        .set("Authorization", auth)
        .send({ name: "https://bad.example" })
    ).status,
    400,
  );
  const domain = await request(app)
    .post(path)
    .set("Authorization", auth)
    .send({ name: `${org}.EXAMPLE.com`, verification_status: "verified" });
  assert.equal(domain.status, 201);
  assert.equal(domain.body.verification_status, "pending");
  const id = domain.body.id;
  assert.equal(
    (
      await request(app)
        .post(path)
        .set("Authorization", auth)
        .send({ name: `${org}.example.com` })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(app)
        .get(path)
        .set("Authorization", `Bearer ${issueToken(other)}`)
    ).status,
    404,
  );
  const verify = () =>
    request(app)
      .post(`${path}/${id}/verify`)
      .set("Authorization", auth)
      .send({ verified: true });
  const failed = await verify();
  assert.equal(failed.status, 200);
  assert.equal(failed.body.verification_status, "failed");
  assert.equal(failed.body.verification_attempts, 1);
  assert.equal((await verify()).status, 429);
  await pool.query(
    "UPDATE domains SET verification_expires_at=NOW()-INTERVAL '1 day' WHERE id=$1",
    [id],
  );
  assert.equal((await verify()).status, 409);
  const renewed = await request(app)
    .post(`${path}/${id}/challenge`)
    .set("Authorization", auth);
  assert.equal(renewed.status, 200);
  assert.equal(
    (await verify()).status,
    429,
    "Renewing a challenge must not bypass the per-domain DNS throttle",
  );
  await pool.query(
    "UPDATE domains SET last_attempt_at=NOW()-INTERVAL '61 seconds' WHERE id=$1",
    [id],
  );
  assert.notEqual(
    renewed.body.verification_token,
    domain.body.verification_token,
  );
  const value = renewed.body.dnsChallenge.value as string;
  answers = [[value.slice(0, 20), value.slice(20)]];
  const verified = await verify();
  assert.equal(verified.status, 200);
  assert.equal(verified.body.verification_status, "verified");
  assert.ok(verified.body.verified_at);
  assert.equal(verified.body.mailReadiness, "not-configured");
  assert.equal(
    (
      await request(app)
        .post(`${path}/${id}/challenge`)
        .set("Authorization", auth)
    ).status,
    409,
  );
});
