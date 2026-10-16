import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import pool from "../src/config/database.js";

const email = `auth-${Date.now()}@example.test`;
after(async () => {
  await pool.query("DELETE FROM users WHERE email=$1", [email]);
  await pool.end();
});
test("registration, validation, duplicate conflict, login and protected profile", async () => {
  assert.equal(
    (
      await request(app)
        .post("/api/auth/register")
        .send({ email, password: "short" })
    ).status,
    400,
  );
  const registered = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "LongPassword123!" });
  assert.equal(registered.status, 201);
  assert.equal(JSON.stringify(registered.body).includes("password"), false);
  assert.equal(
    (
      await request(app)
        .post("/api/auth/register")
        .send({ email: email.toUpperCase(), password: "LongPassword123!" })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/auth/login")
        .send({ email, password: "wrong" })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/auth/login")
        .send({ email: "missing@example.test", password: "wrong" })
    ).status,
    401,
  );
  assert.equal((await request(app).get("/api/auth/me")).status, 401);
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .set("Authorization", "Bearer tampered")
    ).status,
    401,
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "LongPassword123!" });
  assert.equal(login.status, 200);
  assert.equal(login.body.expiresIn, 900);
  const me = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${login.body.accessToken}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.email, email);
  assert.equal(me.body.password_hash, undefined);
  assert.equal(
    (
      await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send("{")
    ).status,
    400,
  );
  let last = 0;
  for (let i = 0; i < 21; i++)
    last = (await request(app).post("/api/auth/login").send({})).status;
  assert.equal(last, 429);
});
