import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createSession } from "../src/services/session.service.js";
import pool from "../src/config/database.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { createMailbox } from "../src/services/mailbox.service.js";
import {
  WebmailService,
  assignMailbox,
} from "../src/services/webmail.service.js";
import type {
  WebmailProvider,
  MailCredentials,
} from "../src/adapters/webmail.adapter.js";
const owner = randomUUID(),
  other = randomUUID(),
  sid = randomUUID();
let org: string;
after(async () => {
  if (org) {
    await pool.query(
      "DELETE FROM mailboxes WHERE domain_id IN (SELECT id FROM domains WHERE organization_id=$1)",
      [org],
    );
  }
  if (org) await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other],
  ]);
  await pool.end();
});
test("webmail requires explicit access, binds sessions, rechecks revocation and loses credentials on restart", async () => {
  for (const id of [owner, other])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,'synthetic',NOW())",
      [id, `${id}@example.test`],
    );
  org = (
    await createOrganization(owner, {
      name: "Webmail access",
      slug: randomUUID(),
    })
  ).id;
  const domain = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,verification_status,mail_activation) VALUES($1,$2,'synthetic','verified','local-lab') RETURNING id",
      [org, `${org}.example.test`],
    )
  ).rows[0]!.id;
  const mailbox = await createMailbox(owner, org, {
    domainId: domain,
    localPart: "inbox",
    quotaMb: 100,
  });
  const password = "synthetic-mailbox-only";
  let calls = 0,
    composeCalls = 0,
    failCompose = false,
    partialCompose = false;
  const inspect = async (value: MailCredentials) => {
    calls++;
    assert.equal(value.password, password);
    assert.equal(value.address, `inbox@${org}.example.test`);
  };
  const provider: WebmailProvider = {
    mode: "local-lab",
    authenticate: inspect,
    folders: async (v) => {
      await inspect(v);
      return [];
    },
    createFolder: async () => {},
    list: async () => [],
    message: async () => ({}),
    attachment: async () => ({
      filename: '"\r\nX-Injected: yes',
      content: Buffer.from("synthetic"),
    }),
    change: async () => {},
    compose: async () => {
      composeCalls++;
      if (failCompose) throw new Error("synthetic uncertain effect");
      return {
        smtpAccepted: true,
        sentCopyStored: true,
        draftSaved: false,
        acceptedRecipients: ["recipient@example.test"],
        rejectedRecipients: partialCompose ? ["rejected@example.test"] : [],
      };
    },
  };
  const service = new WebmailService(provider),
    input = { mailboxId: mailbox.id, password };
  await assert.rejects(new WebmailService().connect(owner, sid, input));
  await assert.rejects(service.connect(owner, sid, input));
  assert.equal(calls, 0);
  await assignMailbox(owner, org, mailbox.id, {
    userId: owner,
    permission: "read",
  });
  await assert.rejects(service.connect(owner, undefined, input));
  const session = await service.connect(owner, sid, input);
  await service.folders(owner, sid, session.token);
  const ownerContact = await service.saveContact(owner, sid, session.token, {
    displayName: "Owner contact",
    email: "shared@example.test",
  });
  assert.equal(ownerContact.email, "shared@example.test");
  assert.equal((await service.contacts(owner, sid, session.token)).length, 1);
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'member')",
    [other, org],
  );
  await assignMailbox(owner, org, mailbox.id, {
    userId: other,
    permission: "read",
  });
  const otherMail = await service.connect(other, sid, input);
  const otherContact = await service.saveContact(other, sid, otherMail.token, {
    displayName: "Other contact",
    email: "shared@example.test",
  });
  assert.notEqual(otherContact.id, ownerContact.id);
  assert.equal((await service.contacts(owner, sid, session.token)).length, 1);
  assert.equal((await service.contacts(other, sid, otherMail.token)).length, 1);
  const before = calls;
  await assert.rejects(service.folders(other, sid, session.token));
  await assert.rejects(service.folders(owner, randomUUID(), session.token));
  await assert.rejects(
    service.compose(owner, sid, session.token, {
      to: ["other@example.test"],
      subject: "test",
      text: "test",
    }),
  );
  assert.equal(calls, before);
  service.disconnect(other, sid, session.token);
  await service.folders(owner, sid, session.token);
  await assert.rejects(
    new WebmailService(provider).folders(owner, sid, session.token),
  );
  await assignMailbox(owner, org, mailbox.id, {
    userId: owner,
    permission: "revoke",
  });
  const revoked = calls;
  await assert.rejects(service.folders(owner, sid, session.token));
  assert.equal(calls, revoked);
  await assignMailbox(owner, org, mailbox.id, {
    userId: owner,
    permission: "write",
  });
  const next = await service.connect(owner, sid, input);
  const sendKey = randomUUID(),
    sendMessage = {
      idempotencyKey: sendKey,
      to: ["recipient@example.test"],
      subject: "Durable synthetic send",
      text: "private synthetic message marker",
    };
  const accepted = await service.compose(owner, sid, next.token, sendMessage);
  assert.equal(accepted.smtpAccepted, true);
  const replay = await service.compose(owner, sid, next.token, sendMessage);
  assert.equal("replayed" in replay && replay.replayed, true);
  assert.equal(composeCalls, 1);
  await assert.rejects(
    service.compose(owner, sid, next.token, {
      ...sendMessage,
      subject: "Changed under the same key",
    }),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  failCompose = true;
  const uncertain = { ...sendMessage, idempotencyKey: randomUUID() };
  await assert.rejects(
    service.compose(owner, sid, next.token, uncertain),
    (error: unknown) => (error as { status?: number }).status === 503,
  );
  failCompose = false;
  await assert.rejects(
    service.compose(owner, sid, next.token, uncertain),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  assert.equal(composeCalls, 2);
  partialCompose = true;
  const partialMessage = {
    ...sendMessage,
    idempotencyKey: randomUUID(),
    to: ["recipient@example.test", "rejected@example.test"],
  };
  const partial = await service.compose(owner, sid, next.token, partialMessage);
  assert.deepEqual(partial.rejectedRecipients, ["rejected@example.test"]);
  const partialReplay = await service.compose(
    owner,
    sid,
    next.token,
    partialMessage,
  );
  assert.equal(
    "rejectedRecipientCount" in partialReplay &&
      partialReplay.rejectedRecipientCount,
    1,
  );
  assert.equal(composeCalls, 3);
  await assert.rejects(
    service.compose(owner, sid, next.token, {
      ...sendMessage,
      idempotencyKey: randomUUID(),
      attachments: [
        {
          filename: "too-large.bin",
          contentBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        },
      ],
    }),
  );
  assert.equal(composeCalls, 3);
  const summaries = await service.sendAttempts(owner, sid, next.token);
  assert.deepEqual(
    summaries.map((row) => row.state),
    ["accepted", "uncertain", "accepted"],
  );
  assert.equal(summaries[0]?.rejectedRecipientCount, 1);
  const uncertainSummary = summaries.find((row) => row.state === "uncertain");
  assert.ok(uncertainSummary?.id);
  await assert.rejects(
    service.resolveSendAttempt(other, sid, otherMail.token, uncertainSummary.id, {
      resolution: "confirmed_not_sent",
    }),
  );
  // Even another writer of the same mailbox cannot resolve the actor's attempt.
  await assignMailbox(owner,org,mailbox.id,{userId:other,permission:"write"});
  await assert.rejects(
    service.resolveSendAttempt(other,sid,otherMail.token,uncertainSummary.id,{
      resolution:"confirmed_not_sent",
    }),
    (error: unknown) => (error as {status?: number}).status === 404,
  );
  await assignMailbox(owner,org,mailbox.id,{userId:other,permission:"read"});
  await assert.rejects(
    service.resolveSendAttempt(owner, sid, next.token, summaries[0].id, {
      resolution: "confirmed_not_sent",
    }),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  const resolved = await service.resolveSendAttempt(
    owner,
    sid,
    next.token,
    uncertainSummary.id,
    { resolution: "confirmed_not_sent" },
  );
  assert.equal(resolved.resolution, "confirmed_not_sent");
  await assert.rejects(
    service.compose(owner, sid, next.token, uncertain),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  assert.equal(composeCalls, 3);
  assert.equal(
    Number((await pool.query(
      "SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='webmail.send_attempt.resolved'",
      [uncertainSummary.id],
    )).rows[0].count),
    1,
  );
  assert.equal(
    (
      await service.resolveSendAttempt(
        owner,
        sid,
        next.token,
        uncertainSummary.id,
        { resolution: "confirmed_not_sent" },
      )
    ).resolution,
    "confirmed_not_sent",
  );
  await assert.rejects(
    service.resolveSendAttempt(owner, sid, next.token, uncertainSummary.id, {
      resolution: "confirmed_sent",
    }),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  assert.equal(
    (await service.sendAttempts(owner, sid, next.token)).find(
      (row) => row.id === uncertainSummary.id,
    )?.resolution,
    "confirmed_not_sent",
  );
  const attempts = (
    await pool.query(
      "SELECT request_digest,state,resolution FROM webmail_send_attempts WHERE mailbox_id=$1 ORDER BY created_at",
      [mailbox.id],
    )
  ).rows;
  assert.deepEqual(
    attempts.map((row) => row.state),
    ["accepted", "uncertain", "accepted"],
  );
  assert.doesNotMatch(
    JSON.stringify(attempts),
    /private synthetic message marker/,
  );
  await pool.query(
    "UPDATE mailboxes SET desired_status='suspended' WHERE id=$1",
    [mailbox.id],
  );
  await assert.rejects(service.folders(owner, sid, next.token));
  await pool.query("UPDATE mailboxes SET desired_status='active' WHERE id=$1", [
    mailbox.id,
  ]);
  const app = createApp({ webmailProvider: provider });
  const dashboard = await createSession(owner, "synthetic");
  const bearer = `Bearer ${dashboard.accessToken}`;
  assert.equal(
    (
      await request(app)
        .post("/api/webmail/connect")
        .set("Authorization", bearer)
        .send(input)
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/webmail/connect")
        .set("Authorization", bearer)
        .set("X-Nuvomailo-CSRF", "1")
        .set("Origin", "https://foreign.invalid")
        .send(input)
    ).status,
    403,
  );
  const response = await request(app)
    .post("/api/webmail/connect")
    .set("Authorization", bearer)
    .set("X-Nuvomailo-CSRF", "1")
    .send(input);
  assert.equal(response.status, 200);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /synthetic-mailbox-only|token|password/,
  );
  const cookie = String(response.headers["set-cookie"]?.[0]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/webmail/);
  const rawCookie = cookie.split(";")[0]!;
  assert.equal(
    (
      await request(app)
        .get("/api/webmail/folders")
        .set("Authorization", bearer)
        .set("Cookie", rawCookie)
    ).status,
    200,
  );
  const contactResponse = await request(app)
    .post("/api/webmail/contacts")
    .set("Authorization", bearer)
    .set("Cookie", rawCookie)
    .set("X-Nuvomailo-CSRF", "1")
    .send({ displayName: "HTTP contact", email: "http@example.test" });
  assert.equal(contactResponse.status, 201);
  const contactsResponse = await request(app)
    .get("/api/webmail/contacts")
    .set("Authorization", bearer)
    .set("Cookie", rawCookie);
  assert.equal(contactsResponse.status, 200);
  assert.deepEqual(
    new Set(contactsResponse.body.map((item: { email: string }) => item.email)),
    new Set(["shared@example.test", "http@example.test"]),
  );
  const attemptResponse = await request(app)
    .get("/api/webmail/send-attempts")
    .set("Authorization", bearer)
    .set("Cookie", rawCookie);
  assert.equal(attemptResponse.status, 200);
  assert.equal(attemptResponse.body.length, 3);
  assert.doesNotMatch(
    JSON.stringify(attemptResponse.body),
    /subject|message|digest/i,
  );
  assert.equal(
    (
      await request(app)
        .post(
          `/api/webmail/send-attempts/${uncertainSummary.id}/resolve`,
        )
        .set("Authorization", bearer)
        .set("Cookie", rawCookie)
        .set("X-Nuvomailo-CSRF", "1")
        .send({ resolution: "confirmed_not_sent" })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .delete(`/api/webmail/contacts/${contactResponse.body.id}`)
        .set("Authorization", bearer)
        .set("Cookie", rawCookie)
        .set("X-Nuvomailo-CSRF", "1")
    ).status,
    204,
  );
  const download = await request(app)
    .get("/api/webmail/attachment?folder=INBOX&uid=1&validity=5&index=0")
    .set("Authorization", bearer)
    .set("Cookie", rawCookie);
  assert.equal(download.status, 200);
  assert.equal(download.headers["content-type"], "application/octet-stream");
  assert.equal(download.headers["x-injected"], undefined);
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  const otherSession = await createSession(owner, "synthetic");
  assert.equal(
    (
      await request(app)
        .get("/api/webmail/folders")
        .set("Authorization", `Bearer ${otherSession.accessToken}`)
        .set("Cookie", rawCookie)
    ).status,
    409,
  );
  await pool.query(
    "UPDATE domains SET mail_activation='disabled' WHERE id=$1",
    [domain],
  );
  await assert.rejects(service.folders(owner, sid, next.token));
  const audits = (
    await pool.query(
      "SELECT metadata FROM audit_events WHERE organization_id=$1",
      [org],
    )
  ).rows;
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(password));
});
