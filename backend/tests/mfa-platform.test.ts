import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import pool from "../src/config/database.js";
import * as mfa from "../src/services/mfa.service.js";
import * as platform from "../src/services/platform.service.js";
import * as incidents from "../src/services/incident.service.js";
import { registerUser, loginUser } from "../src/services/auth.service.js";
import { digest, refreshSession } from "../src/services/session.service.js";
import {
  createOrganization,
  updateOrganization,
} from "../src/services/tenant.service.js";
const email = `mfa-${randomUUID()}@example.test`,
  key = randomBytes(32),
  password = "SyntheticMfaPassword123!";
let id: string, org: string;
const planId = `test-${randomUUID().slice(0, 20)}`;
let incidentId: string | undefined;
const plan = {
  name: "Synthetic staff catalog",
  currency: "USD",
  monthlyMinor: 0,
  yearlyMinor: 0,
  maxDomains: 2,
  maxMailboxes: 5,
  maxMembers: 5,
  maxQuotaMb: 200,
  storageMb: 1000,
  maxMailboxesPerDomain: 5,
  active: true,
};
after(async () => {
  if (incidentId)
    await pool.query("DELETE FROM platform_incidents WHERE id=$1", [
      incidentId,
    ]);
  if (org)
    await pool.query(
      "DELETE FROM mailboxes WHERE domain_id IN(SELECT id FROM domains WHERE organization_id=$1)",
      [org],
    );
  if (org) await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE email=$1", [email]);
  await pool.query("DELETE FROM plans WHERE id=$1", [planId]);
  await pool.end();
});
test("standard TOTP enrollment encrypts secrets, requires possession, rejects replay and uses single-use recovery; staff needs persisted role and recent MFA", async () => {
  id = (await registerUser({ email, password })).id;
  org = (await createOrganization(id, { name: "MFA test", slug: randomUUID() }))
    .id;
  await assert.rejects(mfa.enroll(id, { password }));
  const enrollment = await mfa.enroll(id, { password }, key);
  const otp = OTPAuth.URI.parse(enrollment.uri) as OTPAuth.TOTP;
  const pending = (
    await pool.query("SELECT mfa_pending_enc FROM users WHERE id=$1", [id])
  ).rows[0]!.mfa_pending_enc;
  assert.equal(pending.includes(otp.secret.base32), false);
  await assert.rejects(mfa.confirm(id, { factor: "not-a-token" }, key));
  const enrollmentFactor = otp.generate();
  const setup = await mfa.confirm(id, { factor: enrollmentFactor }, key);
  assert.equal(setup.recoveryCodes.length, 10);
  await assert.rejects(loginUser({ email, password }, key));
  await assert.rejects(
    loginUser({ email, password, factor: enrollmentFactor }, key),
  ); // Enrollment token already consumed.
  const factor = otp.generate({ timestamp: Date.now() + 30000 });
  const login = await loginUser({ email, password, factor }, key);
  await assert.rejects(loginUser({ email, password, factor }, key));
  const recovered = await loginUser(
    { email, password, factor: setup.recoveryCodes[0] },
    key,
  );
  await assert.rejects(
    loginUser({ email, password, factor: setup.recoveryCodes[0] }, key),
  );
  const session = (
    await pool.query("SELECT session_id FROM refresh_tokens WHERE digest=$1", [
      digest(login.refreshToken),
    ])
  ).rows[0]!.session_id as string;
  await assert.rejects(platform.requireStaff(id, session)); // Organization owner is not platform staff.
  await assert.rejects(platform.operationalHealth(id, session));
  await pool.query(
    "INSERT INTO platform_staff(user_id,role) VALUES($1,'viewer')",
    [id],
  );
  await assert.rejects(platform.requireStaff(id, session)); // Email proof is independently required.
  await pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
    id,
  ]);
  assert.equal(await platform.requireStaff(id, session), "viewer");
  await assert.rejects(
    incidents.open(id, session, {
      component: "backup",
      symptom: "recovery-failed",
      severity: "critical",
    }),
  );
  const health = await platform.operationalHealth(id, session);
  assert.equal(health.source, "control-plane-database");
  assert.equal(health.mailTransport, "not-observed");
  assert.equal(health.externalNotifications, false);
  assert.ok(Array.isArray(await platform.catalog(id, session)));
  await assert.rejects(platform.updatePlan(id, session, planId, plan));
  const domain = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,verification_status) VALUES($1,$2,'synthetic','verified') RETURNING id",
      [org, `${org}.example.test`],
    )
  ).rows[0]!.id;
  const box = (
    await pool.query(
      "INSERT INTO mailboxes(domain_id,local_part) VALUES($1,'staff-test') RETURNING id",
      [domain],
    )
  ).rows[0]!.id;
  const job = (
    await pool.query(
      "INSERT INTO provisioning_requests(mailbox_id,operation,quota_mb,revision,desired_status,state) VALUES($1,'create',100,1,'active','failed') RETURNING id",
      [box],
    )
  ).rows[0]!.id;
  await assert.rejects(
    platform.retryJob(id, session, job, { reason: "provider-recovered" }),
  );
  await assert.rejects(
    platform.setStatus(id, session, "organization", org, {
      status: "suspended",
      reason: "owner-request",
    }),
  );
  await pool.query(
    "UPDATE platform_staff SET role='operator' WHERE user_id=$1",
    [id],
  );
  await platform.setStatus(id, session, "organization", org, {
    status: "suspended",
    reason: "owner-request",
  });
  await assert.rejects(
    platform.retryJob(id, session, job, { reason: "provider-recovered" }),
  );
  await assert.rejects(
    updateOrganization(id, org, { name: "Blocked while suspended" }),
  );
  await platform.setStatus(id, session, "organization", org, {
    status: "active",
    reason: "owner-request",
  });
  await pool.query(
    "UPDATE identity_sessions SET mfa_verified_at=NOW()-INTERVAL '16 minutes' WHERE id=$1",
    [session],
  );
  await assert.rejects(platform.requireStaff(id, session));
  await refreshSession(login.refreshToken);
  await assert.rejects(platform.requireStaff(id, session)); // Refresh cannot refresh MFA age.
  await mfa.stepUp(id, session, { factor: setup.recoveryCodes[1] }, key);
  assert.equal(await platform.requireStaff(id, session), "operator");
  const incident = await incidents.open(id, session, {
    component: "backup",
    symptom: "recovery-failed",
    severity: "critical",
  });
  incidentId = incident.id;
  await assert.rejects(
    incidents.open(id, session, {
      component: "backup",
      symptom: "recovery-failed",
      severity: "critical",
    }),
  );
  await assert.rejects(
    incidents.transition(id, session, incident.id, {
      version: 1,
      action: "resolve",
    }),
  );
  const outcomes = await Promise.allSettled([
    incidents.transition(id, session, incident.id, {
      version: 1,
      action: "acknowledge",
    }),
    incidents.transition(id, session, incident.id, {
      version: 1,
      action: "acknowledge",
    }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  await assert.rejects(
    incidents.transition(id, session, incident.id, {
      version: 1,
      action: "resolve",
    }),
  );
  assert.equal(
    (
      await incidents.transition(id, session, incident.id, {
        version: 2,
        action: "resolve",
      })
    ).state,
    "resolved",
  );
  assert.equal(
    (await incidents.list(id, session)).notificationDelivery,
    "local-synthetic-available",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM platform_alert_outbox WHERE incident_id=$1",
          [incident.id],
        )
      ).rows[0].count,
    ),
    3,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM platform_events WHERE target_id=$1 AND action LIKE 'incident.%'",
          [incident.id],
        )
      ).rows[0].count,
    ),
    3,
  );
  const updated = await platform.updatePlan(id, session, planId, plan);
  assert.equal(updated.id, planId);
  await assert.rejects(
    platform.updatePlan(id, session, planId, { ...plan, maxQuotaMb: 0 }),
  );
  assert.equal(
    (
      await platform.retryJob(id, session, job, {
        reason: "provider-recovered",
      })
    ).state,
    "pending",
  );
  await assert.rejects(
    platform.retryJob(id, session, job, { reason: "provider-recovered" }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM platform_events WHERE actor_user_id=$1 AND action='provisioning.staff_retry'",
        [id],
      )
    ).rows[0]!.n,
    1,
  );
  await assert.rejects(
    mfa.disable(id, { password, factor: setup.recoveryCodes[2] }, key),
  );
  const persisted = JSON.stringify(
    (
      await pool.query("SELECT * FROM mfa_recovery_codes WHERE user_id=$1", [
        id,
      ])
    ).rows,
  );
  assert.equal(persisted.includes(setup.recoveryCodes[0]!), false);
  assert.ok(recovered.accessToken);
});
