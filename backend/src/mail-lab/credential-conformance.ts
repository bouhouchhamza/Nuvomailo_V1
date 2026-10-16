import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pool from "../config/database.js";
import { LocalCredentialBroker } from "../adapters/credential-broker.adapter.js";
import { LocalCredentialApplier } from "../adapters/credential-applier.adapter.js";
import { LocalImapSmtpProvider } from "../adapters/webmail.adapter.js";
import {
  MailboxCredentialService,
  runCredentialOnce,
  type CredentialTarget,
} from "../services/mailbox-credential.service.js";
import {
  createSession,
  hashPassword,
  digest,
} from "../services/session.service.js";
import { rpc } from "./rpc.js";
import request from "supertest";
import { createApp } from "../app.js";
let stage = "initialization",
  created = false;
const actor = randomUUID(),
  box = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
try {
  const broker = new LocalCredentialBroker();
  if (process.argv[2] === "denied-peer") {
    await assert.rejects(broker.hash("SyntheticDeniedPassword123!"));
    console.log(JSON.stringify({ passed: true, check: "broker-denied-peer" }));
  } else {
    const key = Buffer.from(
      (await readFile("/run/nuvomailo-credential-vault/key", "utf8")).trim(),
      "hex",
    );
    const dashboard = randomBytes(32).toString("base64url"),
      password1 = randomBytes(32).toString("base64url"),
      password2 = randomBytes(32).toString("base64url");
    const dashboardHash = await hashPassword(dashboard);
    await pool.query(
      "INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,$3,NOW())",
      [actor, `${actor}@lab.invalid`, dashboardHash],
    );
    created = true;
    await pool.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,'11111111-1111-4111-8111-111111111111','member')",
      [actor],
    );
    await pool.query(
      "INSERT INTO mailboxes(id,domain_id,local_part) VALUES($1,'44444444-4444-4444-8444-444444444444','credential') ON CONFLICT(id) DO NOTHING",
      [box],
    );
    await pool.query(
      "INSERT INTO mailbox_access(mailbox_id,user_id,permission) VALUES($1,$2,'write')",
      [box, actor],
    );
    const session = await createSession(actor, dashboardHash),
      sid = (
        await pool.query(
          "SELECT session_id FROM refresh_tokens WHERE digest=$1",
          [digest(session.refreshToken)],
        )
      ).rows[0]!.session_id;
    const delivered: { token: string }[] = [];
    const service = new MailboxCredentialService(broker, key, {
      send: async (v) => {
        delivered.push(v);
      },
    });
    const target = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      mailboxId: box,
      address: "credential@tenant-a.lab.invalid",
      revision: 1,
      quotaMb: 100,
      status: "active",
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    stage = "provision";
    assert.equal((await rpc("/v1/ensure", target)).status, 200);
    stage = "native-hash";
    const native = await broker.hash(password1);
    assert.ok(native.startsWith("{ARGON2ID}$argon2id$"));
    const generation = (
      await pool.query(
        "SELECT credential_generation FROM mailboxes WHERE id=$1",
        [box],
      )
    ).rows[0]!.credential_generation;
    const purpose = generation === 0 ? "setup" : "reset";
    stage = "grant";
    const app = createApp({ mailboxCredentialService: service }),
      bearer = `Bearer ${session.accessToken}`;
    const issuance = await request(app)
      .post(`/api/mailbox-credentials/${box}/grants`)
      .set("Authorization", bearer)
      .set("X-Nuvomailo-CSRF", "1")
      .send({
        purpose,
        dashboardPassword: dashboard,
      });
    assert.equal(issuance.status, 202);
    assert.doesNotMatch(JSON.stringify(issuance.body), /token|password|hash/);
    const token = delivered.at(-1)!.token;
    const consumption = await request(app)
      .post("/api/mailbox-credentials/consume")
      .set("Authorization", bearer)
      .set("X-Nuvomailo-CSRF", "1")
      .send({
        token,
        purpose,
        password: password1,
      });
    assert.equal(consumption.status, 202);
    const first = consumption.body as { generation: number };
    await assert.rejects(
      service.consume(actor, sid, { token, purpose, password: password1 }),
    );
    const applier = new LocalCredentialApplier();
    let firstTarget: CredentialTarget | undefined;
    stage = "first-apply";
    let firstResult = "idle";
    for (let attempt = 0; attempt < 5 && firstResult === "idle"; attempt++)
      firstResult = await runCredentialOnce(key, {
        apply: async (value) => {
          firstTarget = value;
          await applier.apply(value);
        },
      });
    assert.equal(firstResult, "applied");
    const provider = new LocalImapSmtpProvider(
      await readFile("/run/nuvomailo-public-trust/lab-cert.pem"),
    );
    stage = "first-login";
    await provider.authenticate({
      address: target.address,
      password: password1,
    });
    stage = "rotation";
    await service.issue(actor, sid, box, {
      purpose: "rotate",
      dashboardPassword: dashboard,
    });
    await service.consume(actor, sid, {
      token: delivered.at(-1)!.token,
      purpose: "rotate",
      password: password2,
    });
    let secondTarget: CredentialTarget | undefined;
    assert.equal(
      await runCredentialOnce(key, {
        apply: async (value) => {
          secondTarget = value;
          await applier.apply(value);
        },
      }),
      "applied",
    );
    stage = "new-login";
    await provider.authenticate({
      address: target.address,
      password: password2,
    });
    await assert.rejects(
      provider.authenticate({ address: target.address, password: password1 }),
    );
    if (process.argv[2] === "restart-check") {
      stage = "restart-wait";
      console.log(JSON.stringify({ checkpoint: "restart-required" }));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("RESTART_TIMEOUT")),
          90000,
        );
        process.stdin.once("data", (data) => {
          clearTimeout(timer);
          if (data.toString().trim() === "resume") resolve();
          else reject(new Error("INVALID_RESUME"));
        });
      });
      stage = "restart-login";
      await provider.authenticate({
        address: target.address,
        password: password2,
      });
      stage = "restart-replay";
      assert.ok(secondTarget);
      await applier.apply(secondTarget);
      await broker.hash(randomBytes(32).toString("base64url"));
    }
    stage = "remote-fence";
    assert.ok(firstTarget);
    assert.equal((await rpc("/v1/credential", firstTarget)).status, 409);
    const rows =
      JSON.stringify(
        (
          await pool.query(
            "SELECT * FROM mailbox_credential_requests WHERE mailbox_id=$1",
            [box],
          )
        ).rows,
      ) +
      JSON.stringify(
        (
          await pool.query("SELECT * FROM audit_events WHERE resource_id=$1", [
            box,
          ])
        ).rows,
      ) +
      JSON.stringify(
        (
          await pool.query(
            "SELECT * FROM mailbox_credential_artifacts WHERE mailbox_id=$1",
            [box],
          )
        ).rows,
      );
    for (const secret of [password1, password2, dashboard, token, native])
      assert.ok(!rows.includes(secret));
    stage = "independent-inspect";
    assert.equal((await rpc("/v1/inspect", target)).body.status, "active");
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          "native-argon2id",
          "single-use-grant",
          "encrypted-artifacts",
          "real-imap-password-setup",
          "real-password-rotation",
          "old-password-rejected",
          "remote-generation-fence",
          "managed-passdb-inspect",
          "no-secret-in-db-queue-audit",
          ...(process.argv[2] === "restart-check"
            ? ["mail-broker-restart", "credential-replay-after-restart"]
            : []),
        ],
        generation: first.generation,
      }),
    );
  }
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "CREDENTIAL_CONFORMANCE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  if (created) await pool.query("DELETE FROM users WHERE id=$1", [actor]);
  await pool.end();
}
