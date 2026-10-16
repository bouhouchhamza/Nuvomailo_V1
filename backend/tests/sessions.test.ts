import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import pool from "../src/config/database.js";
import {
  requestGrant,
  consumeGrant,
  refreshSession,
  hashPassword,
  digest,
  createSession,
} from "../src/services/session.service.js";
const email = `session-${randomUUID()}@example.test`;
const delivered: {
  email: string;
  purpose: "reset" | "verify";
  token: string;
}[] = [];
const sink = {
  send: async (value: (typeof delivered)[number]) => {
    delivered.push(value);
  },
};
const app = createApp({ identityNotification: sink });
let userId: string;
after(async () => {
  await pool.query("DELETE FROM users WHERE email=$1", [email]);
  await pool.end();
});
test("persistent sessions rotate, reject replay/concurrency, expire, revoke and bind to active identity", async () => {
  const password = "SeparateDashboardPassword123!";
  userId = (
    await request(app).post("/api/auth/register").send({ email, password })
  ).body.id;
  const login = await request(app)
    .post("/api/auth/login")
    .send({ email, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.refreshToken, undefined);
  const setCookie = (login.headers["set-cookie"] as unknown as string[])[0]!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0]!;
  assert.equal(
    (await request(app).post("/api/auth/refresh").set("Cookie", cookie)).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", cookie)
        .set("X-Nuvomailo-CSRF", "1")
        .set("Origin", "https://attacker.invalid")
    ).status,
    403,
  );
  const renewed = await request(app)
    .post("/api/auth/refresh")
    .set("Cookie", cookie)
    .set("X-Nuvomailo-CSRF", "1");
  assert.equal(renewed.status, 200);
  assert.notEqual(
    (renewed.headers["set-cookie"] as unknown as string[])[0],
    setCookie,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .auth(renewed.body.accessToken, { type: "bearer" })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", cookie)
        .set("X-Nuvomailo-CSRF", "1")
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .auth(renewed.body.accessToken, { type: "bearer" })
    ).status,
    401,
  );
  const hash = (
    await pool.query("SELECT password_hash FROM users WHERE id=$1", [userId])
  ).rows[0]!.password_hash as string;
  const session = await createSession(userId, hash);
  const concurrent = await Promise.allSettled([
    refreshSession(session.refreshToken),
    refreshSession(session.refreshToken),
  ]);
  assert.equal(concurrent.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .auth(session.accessToken, { type: "bearer" })
    ).status,
    401,
  );
  const expired = await createSession(userId, hash);
  await pool.query(
    "UPDATE identity_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=(SELECT session_id FROM refresh_tokens WHERE digest=$1)",
    [digest(expired.refreshToken)],
  );
  await assert.rejects(refreshSession(expired.refreshToken));
  const active = await request(app)
    .post("/api/auth/login")
    .send({ email, password });
  assert.equal(
    (
      await request(app)
        .post("/api/auth/logout")
        .auth(active.body.accessToken, { type: "bearer" })
        .set("X-Nuvomailo-CSRF", "1")
    ).status,
    204,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .auth(active.body.accessToken, { type: "bearer" })
    ).status,
    401,
  );
  await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
  assert.equal(
    (await request(app).post("/api/auth/login").send({ email, password }))
      .status,
    401,
  );
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
});
test("single-use identity grants are purpose-bound, expiring, revocable and concurrency-safe; password reset revokes sessions", async () => {
  await requestGrant(email, "verify", sink);
  const verify = delivered.at(-1)!.token;
  await assert.rejects(
    consumeGrant(
      { token: verify, password: "WrongPurposePassword123!" },
      "reset",
    ),
  );
  await consumeGrant({ token: verify }, "verify");
  await assert.rejects(consumeGrant({ token: verify }, "verify"));
  assert.ok(
    (
      await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [
        userId,
      ])
    ).rows[0]!.email_verified_at,
  );
  await requestGrant(email, "reset", sink);
  const old = delivered.at(-1)!.token;
  await requestGrant(email, "reset", sink);
  const reset = delivered.at(-1)!.token;
  await assert.rejects(
    consumeGrant({ token: old, password: "NewDashboardPassword123!" }, "reset"),
  );
  const hash = (
    await pool.query("SELECT password_hash FROM users WHERE id=$1", [userId])
  ).rows[0]!.password_hash;
  const session = await createSession(userId, hash);
  const outcomes = await Promise.allSettled([
    consumeGrant(
      { token: reset, password: "NewDashboardPassword123!" },
      "reset",
    ),
    consumeGrant(
      { token: reset, password: "NewDashboardPassword123!" },
      "reset",
    ),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .auth(session.accessToken, { type: "bearer" })
    ).status,
    401,
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "NewDashboardPassword123!" });
  assert.equal(login.status, 200);
  assert.equal(
    (
      await request(app)
        .post("/api/auth/change-password")
        .auth(login.body.accessToken, { type: "bearer" })
        .send({
          currentPassword: "NewDashboardPassword123!",
          password: "ChangedDashboardPassword123!",
        })
    ).status,
    204,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/auth/me")
        .auth(login.body.accessToken, { type: "bearer" })
    ).status,
    401,
  );
  await requestGrant(email, "reset", sink);
  const expired = delivered.at(-1)!.token;
  await pool.query(
    "UPDATE identity_grants SET expires_at=NOW()-INTERVAL '1 second' WHERE digest=$1",
    [digest(expired)],
  );
  await assert.rejects(
    consumeGrant({ token: expired, password: "ExpiryMustReject123!" }, "reset"),
  );
  const found = await request(app)
    .post("/api/auth/forgot-password")
    .send({ email });
  const missing = await request(app)
    .post("/api/auth/forgot-password")
    .send({ email: "not-a-user@example.test" });
  assert.equal(found.status, 202);
  assert.deepEqual(found.body, missing.body);
  const persisted =
    JSON.stringify(
      (
        await pool.query("SELECT * FROM identity_grants WHERE user_id=$1", [
          userId,
        ])
      ).rows,
    ) +
    JSON.stringify(
      (
        await pool.query("SELECT * FROM security_events WHERE user_id=$1", [
          userId,
        ])
      ).rows,
    );
  for (const message of delivered)
    assert.equal(persisted.includes(message.token), false);
  assert.equal(persisted.includes("NewDashboardPassword"), false);
});
