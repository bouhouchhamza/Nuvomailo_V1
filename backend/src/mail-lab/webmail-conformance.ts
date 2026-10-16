import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { LocalImapSmtpProvider } from "../adapters/webmail.adapter.js";
import request from "supertest";
import pool from "../config/database.js";
import { createApp } from "../app.js";
import { createSession } from "../services/session.service.js";

// Synthetic credential arrives only through stdin, never argv/environment/results.
let stage = "input";
const actor = randomUUID();
let createdActor = false;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2048) throw new Error("INPUT_LIMIT");
  }
  const value = JSON.parse(input) as { address: string; password: string };
  assert.equal(value.address, "pilot@tenant-a.lab.invalid");
  const provider = new LocalImapSmtpProvider(
    readFileSync("/run/nuvomailo-public-trust/lab-cert.pem"),
  );
  stage = "authentication";
  await provider.authenticate(value);
  const marker = `webmail-${randomUUID()}`;
  const message = {
    to: [value.address],
    cc: [],
    bcc: [value.address],
    subject: marker,
    text: "Synthetic webmail conformance",
    html: '<p>Safe content</p><script>bad()</script><img src="https://tracker.invalid">',
    attachments: [
      {
        filename: "synthetic.txt",
        contentBase64: Buffer.from("Synthetic attachment content").toString(
          "base64",
        ),
      },
    ],
  };
  await assert.rejects(
    provider.compose(
      value,
      { ...message, to: ["blocked@example.test"] },
      false,
    ),
  );
  stage = "draft";
  const draft = (await provider.compose(value, message, true)) as {
    draftSaved: boolean;
  };
  assert.equal(draft.draftSaved, true);
  stage = "send";
  const sent = (await provider.compose(value, message, false)) as {
    smtpAccepted: boolean;
    sentCopyStored: boolean;
  };
  assert.equal(sent.smtpAccepted, true);
  assert.equal(sent.sentCopyStored, true);
  stage = "partial-send";
  const missing = `missing-${randomUUID()}@tenant-a.lab.invalid`;
  const partial = (await provider.compose(
    value,
    { ...message, to: [value.address, missing], subject: marker + "-partial" },
    false,
  )) as {
    smtpAccepted: boolean;
    sentCopyStored: boolean;
    acceptedRecipients: string[];
    rejectedRecipients: string[];
  };
  stage = "partial-accepted";
  assert.equal(partial.smtpAccepted, true);
  stage = "partial-sent-copy";
  assert.equal(partial.sentCopyStored, true);
  stage = "partial-valid-recipient";
  assert.ok(partial.acceptedRecipients.includes(value.address));
  // Authenticated submission currently accepts unknown local recipients at RCPT.
  // This is submission acceptance, not proof of final delivery to that address.
  stage = "unknown-local-submission";
  assert.ok(partial.acceptedRecipients.includes(missing));
  type Listing = {
    items: { uid: number; subject: string; seen: boolean }[];
    uidValidity: string;
  };
  stage = "draft-inspection";
  const drafts = (await provider.list(
    value,
    "Drafts",
    undefined,
    marker,
  )) as Listing;
  assert.equal(drafts.items.length, 1);
  const selected = drafts.items[0]!;
  const parsed = (await provider.message(
    value,
    "Drafts",
    selected.uid,
    drafts.uidValidity,
  )) as { html: string; attachments: unknown[]; bcc?: unknown };
  assert.equal(parsed.html, "<p>Safe content</p>");
  assert.equal(parsed.attachments.length, 1);
  assert.ok(parsed.bcc);
  const attachment = await provider.attachment(
    value,
    "Drafts",
    selected.uid,
    drafts.uidValidity,
    0,
  );
  assert.equal(attachment.content.toString(), "Synthetic attachment content");
  await assert.rejects(provider.message(value, "Drafts", selected.uid, "0"));
  await provider.change(
    value,
    "Drafts",
    selected.uid,
    drafts.uidValidity,
    "read",
  );
  assert.equal(
    ((await provider.list(value, "Drafts", undefined, marker)) as Listing)
      .items[0]!.seen,
    true,
  );
  await provider.change(
    value,
    "Drafts",
    selected.uid,
    drafts.uidValidity,
    "unread",
  );
  assert.equal(
    ((await provider.list(value, "Drafts", undefined, marker)) as Listing)
      .items[0]!.seen,
    false,
  );
  await provider.change(
    value,
    "Drafts",
    selected.uid,
    drafts.uidValidity,
    "trash",
  );
  assert.equal(
    ((await provider.list(value, "Drafts", undefined, marker)) as Listing).items
      .length,
    0,
  );
  assert.equal(
    ((await provider.list(value, "Trash", undefined, marker)) as Listing).items
      .length,
    1,
  );
  stage = "folders";
  await provider.createFolder(value, marker);
  assert.ok(
    ((await provider.folders(value)) as { path: string }[]).some(
      (folder) => folder.path === marker,
    ),
  );
  // Poll boundedly for actual SMTP-to-IMAP delivery, preserving all synthetic mail.
  stage = "delivery";
  let received: Listing | undefined;
  for (let i = 0; i < 10; i++) {
    received = (await provider.list(
      value,
      "INBOX",
      undefined,
      marker,
    )) as Listing;
    if (received.items.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(received?.items.length);
  stage = "http-integration";
  await pool.query(
    "INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,'synthetic-no-dashboard-password',NOW())",
    [actor, `${actor}@lab.invalid`],
  );
  createdActor = true;
  await pool.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,'11111111-1111-4111-8111-111111111111','member')",
    [actor],
  );
  await pool.query(
    "INSERT INTO mailbox_access(mailbox_id,user_id,permission) VALUES('55555555-5555-4555-8555-555555555555',$1,'read')",
    [actor],
  );
  const dashboard = await createSession(
      actor,
      "synthetic-no-dashboard-password",
    ),
    bearer = `Bearer ${dashboard.accessToken}`;
  const app = createApp({ webmailProvider: provider });
  const connected = await request(app)
    .post("/api/webmail/connect")
    .set("Authorization", bearer)
    .set("X-Nuvomailo-CSRF", "1")
    .send({
      mailboxId: "55555555-5555-4555-8555-555555555555",
      password: value.password,
    });
  assert.equal(connected.status, 200);
  assert.ok(!JSON.stringify(connected.body).includes(value.password));
  const cookie = String(connected.headers["set-cookie"]?.[0]).split(";")[0]!;
  const read = await request(app)
    .get(`/api/webmail/messages?folder=INBOX&query=${marker}`)
    .set("Authorization", bearer)
    .set("Cookie", cookie);
  assert.equal(read.status, 200);
  assert.ok(read.body.items.length);
  const denied = await request(app)
    .post("/api/webmail/send")
    .set("Authorization", bearer)
    .set("Cookie", cookie)
    .set("X-Nuvomailo-CSRF", "1")
    .send({
      idempotencyKey: randomUUID(),
      to: [value.address],
      subject: "Read-only send denied",
      text: "Synthetic",
    });
  assert.equal(denied.status, 404);
  await pool.query("DELETE FROM mailbox_access WHERE user_id=$1", [actor]);
  assert.equal(
    (
      await request(app)
        .get("/api/webmail/folders")
        .set("Authorization", bearer)
        .set("Cookie", cookie)
    ).status,
    404,
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "verified-tls-imap",
        "starttls-authenticated-submission",
        "internal-delivery",
        "drafts",
        "sent-copy",
        "search",
        "safe-html",
        "attachment",
        "uidvalidity",
        "read-unread",
        "retained-trash",
        "folder-create",
        "external-recipient-rejection",
        "unknown-local-submission-accepted",
        "private-draft-hidden-recipients-retained",
        "http-dashboard-to-real-imap",
        "http-read-only-send-denied",
        "http-access-revocation",
      ],
      syntheticMailPreserved: true,
    }),
  );
} catch (error) {
  // Provider exceptions, protocol data and credentials must never reach stdout/stderr.
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code:
        error instanceof assert.AssertionError
          ? "ASSERTION_FAILED"
          : "WEBMAIL_CONFORMANCE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  if (createdActor) {
    try {
      await pool.query("DELETE FROM users WHERE id=$1", [actor]);
    } catch {
      console.error('{"passed":false,"stage":"fixture-cleanup"}');
      process.exitCode = 1;
    }
  }
  await pool.end();
}
