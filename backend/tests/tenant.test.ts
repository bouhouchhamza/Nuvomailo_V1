import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import app from "../src/app.js";
import pool from "../src/config/database.js";
import { issueToken } from "../src/middlewares/auth.js";
const ids = [randomUUID(), randomUUID(), randomUUID()];
let orgId: string;
after(async () => {
  if (orgId) await pool.query("DELETE FROM organizations WHERE id=$1", [orgId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});
test("tenant isolation, roles, membership management and protected owner", async () => {
  for (const id of ids)
    await pool.query(
      "INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)",
      [id, `${id}@example.test`, "test-only"],
    );
  const api = (i: number) => request(app);
  const auth = (i: number) => `Bearer ${issueToken(ids[i]!)}`;
  const created = await api(0)
    .post("/api/organizations")
    .set("Authorization", auth(0))
    .send({ name: "Test tenant", slug: `test-${ids[0]}` });
  assert.equal(created.status, 201);
  orgId = created.body.id;
  const path = `/api/organizations/${orgId}`;
  assert.equal(
    (await api(1).get(path).set("Authorization", auth(1))).status,
    404,
  );
  assert.deepEqual(
    (await api(1).get("/api/organizations").set("Authorization", auth(1))).body,
    [],
  );
  assert.equal(
    (
      await api(0)
        .post(`${path}/members`)
        .set("Authorization", auth(0))
        .send({ email: `${ids[1]}@example.test`, role: "member" })
    ).status,
    201,
  );
  assert.equal(
    (await api(1).get(path).set("Authorization", auth(1))).status,
    200,
  );
  assert.equal(
    (
      await api(1)
        .patch(path)
        .set("Authorization", auth(1))
        .send({ name: "Bad" })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(1)
        .post(`${path}/members`)
        .set("Authorization", auth(1))
        .send({ email: `${ids[2]}@example.test`, role: "admin" })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(0)
        .patch(`${path}/members/${ids[1]}`)
        .set("Authorization", auth(0))
        .send({ role: "admin" })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(1)
        .patch(path)
        .set("Authorization", auth(1))
        .send({ name: "Renamed" })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(0)
        .delete(`${path}/members/${ids[0]}`)
        .set("Authorization", auth(0))
    ).status,
    409,
  );
  assert.equal(
    (
      await api(0)
        .delete(`${path}/members/${ids[1]}`)
        .set("Authorization", auth(0))
    ).status,
    204,
  );
  assert.equal(
    (await api(1).get(`${path}/members`).set("Authorization", auth(1))).status,
    404,
  );
  assert.equal((await request(app).get(path)).status, 401);
});
