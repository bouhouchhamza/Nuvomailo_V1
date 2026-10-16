import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pool from "../src/config/database.js";
import { registerUser, loginUser } from "../src/services/auth.service.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { digest } from "../src/services/session.service.js";
import * as support from "../src/services/support-grant.service.js";
const ids: string[] = [],
  orgs: string[] = [],
  password = "SyntheticSupportPassword123!";
after(async () => {
  for (const org of orgs)
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});
test("support diagnostics require owner consent, assigned staff recent MFA and current ownership; expiry/revocation stop access", async () => {
  const sessions: string[] = [];
  for (let n = 0; n < 3; n++) {
    const email = `${randomUUID()}@example.test`,
      user = await registerUser({ email, password });
    ids.push(user.id);
    const login = await loginUser({ email, password });
    sessions.push(
      (
        await pool.query(
          "SELECT session_id FROM refresh_tokens WHERE digest=$1",
          [digest(login.refreshToken)],
        )
      ).rows[0].session_id,
    );
    await pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
      user.id,
    ]);
  }
  const [owner, staff, other] = ids as [string, string, string];
  const org = (
    await createOrganization(owner, {
      name: "Support test",
      slug: randomUUID(),
    })
  ).id;
  orgs.push(org);
  for (const user of [staff, other]) {
    await pool.query("UPDATE users SET mfa_secret_enc=$2 WHERE id=$1", [
      user,
      randomBytes(32).toString("base64"),
    ]);
    await pool.query(
      "INSERT INTO platform_staff(user_id,role) VALUES($1,'viewer')",
      [user],
    );
  }
  await pool.query(
    "UPDATE identity_sessions SET mfa_verified_at=NOW() WHERE id=ANY($1::uuid[])",
    [sessions.slice(1)],
  );
  const input = {
    staffUserId: staff,
    minutes: 15,
    dashboardPassword: password,
  };
  await assert.rejects(support.issue(other, sessions[2], org, input));
  await assert.rejects(support.issue(owner, undefined, org, input));
  await assert.rejects(
    support.issue(owner, sessions[0], org, {
      ...input,
      dashboardPassword: "wrong",
    }),
  );
  await assert.rejects(
    support.issue(owner, sessions[0], org, { ...input, minutes: 120 }),
  );
  const grant = await support.issue(owner, sessions[0], org, input);
  await assert.rejects(support.diagnostics(other, sessions[2], grant.id));
  const result = await support.diagnostics(staff, sessions[1], grant.id);
  assert.deepEqual(result.resources, { domains: 0, mailboxes: 0 });
  assert.doesNotMatch(JSON.stringify(result), /password|email|secret|address/);
  await pool.query(
    "UPDATE identity_sessions SET mfa_verified_at=NOW()-INTERVAL '16 minutes' WHERE id=$1",
    [sessions[1]],
  );
  await assert.rejects(support.diagnostics(staff, sessions[1], grant.id));
  await pool.query(
    "UPDATE identity_sessions SET mfa_verified_at=NOW() WHERE id=$1",
    [sessions[1]],
  );
  await pool.query(
    "UPDATE memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",
    [org, owner],
  );
  await assert.rejects(support.diagnostics(staff, sessions[1], grant.id));
  await pool.query(
    "UPDATE memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2",
    [org, owner],
  );
  await support.revoke(owner, org, grant.id);
  await assert.rejects(support.diagnostics(staff, sessions[1], grant.id));
  const expired = await support.issue(owner, sessions[0], org, input);
  await pool.query(
    "UPDATE support_grants SET created_at=NOW()-INTERVAL '30 minutes',expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(support.diagnostics(staff, sessions[1], expired.id));
  const suspended = await support.issue(owner, sessions[0], org, input);
  await pool.query("UPDATE organizations SET status='suspended' WHERE id=$1", [
    org,
  ]);
  assert.equal((await support.list(owner, org)).length, 3);
  await assert.rejects(support.diagnostics(staff, sessions[1], suspended.id));
  await support.revoke(owner, org, suspended.id);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM audit_events WHERE organization_id=$1 AND action='support.diagnostics_read'",
          [org],
        )
      ).rows[0].count,
    ),
    1,
  );
});
