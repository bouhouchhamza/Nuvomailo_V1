import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import pool from "../src/config/database.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { createSession, digest } from "../src/services/session.service.js";
import {
  MailboxCredentialService,
  runCredentialOnce,
} from "../src/services/mailbox-credential.service.js";
import type { CredentialBroker } from "../src/adapters/credential-broker.adapter.js";
const actor = randomUUID(),
  key = randomBytes(32),
  dashboard = "SyntheticDashboardPassword123!";
let org: string;
after(async () => {
  if (org) {
    await pool.query(
      "DELETE FROM mailboxes WHERE domain_id IN(SELECT id FROM domains WHERE organization_id=$1)",
      [org],
    );
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  }
  await pool.query("DELETE FROM users WHERE id=$1", [actor]);
  await pool.end();
});
test("single-use mailbox grants bind purpose/session, encrypt artifacts, fence generations and recover leases", async () => {
  const hash = await argon2.hash(dashboard);
  await pool.query(
    "INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,$3,NOW())",
    [actor, `${actor}@example.test`, hash],
  );
  org = (
    await createOrganization(actor, {
      name: "Credential grants",
      slug: randomUUID(),
    })
  ).id;
  const domain = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,verification_status,mail_activation) VALUES($1,'tenant-a.lab.invalid','synthetic','verified','local-lab') RETURNING id",
      [org],
    )
  ).rows[0]!.id;
  const mailbox = (
    await pool.query(
      "INSERT INTO mailboxes(domain_id,local_part) VALUES($1,'credential-test') RETURNING id",
      [domain],
    )
  ).rows[0]!.id;
  await pool.query(
    "INSERT INTO mailbox_access(mailbox_id,user_id,permission) VALUES($1,$2,'write')",
    [mailbox, actor],
  );
  const session = await createSession(actor, hash),
    sid = (
      await pool.query(
        "SELECT session_id FROM refresh_tokens WHERE digest=$1",
        [digest(session.refreshToken)],
      )
    ).rows[0]!.session_id;
  const delivered: { token: string }[] = [];
  const broker: CredentialBroker = {
    mode: "local-lab",
    hash: async (secret) => "{ARGON2ID}" + (await argon2.hash(secret)),
  };
  const service = new MailboxCredentialService(broker, key, {
    send: async (v) => {
      delivered.push(v);
    },
  });
  await assert.rejects(
    new MailboxCredentialService().issue(actor, sid, mailbox, {
      purpose: "setup",
      dashboardPassword: dashboard,
    }),
  );
  await assert.rejects(
    service.issue(actor, sid, mailbox, {
      purpose: "setup",
      dashboardPassword: "wrong",
    }),
  );
  await service.issue(actor, sid, mailbox, {
    purpose: "setup",
    dashboardPassword: dashboard,
  });
  const token = delivered.at(-1)!.token;
  await assert.rejects(
    service.consume(actor, sid, {
      token,
      purpose: "rotate",
      password: "SyntheticMailboxPassword1!",
    }),
  );
  await assert.rejects(
    service.consume(actor, randomUUID(), {
      token,
      purpose: "setup",
      password: "SyntheticMailboxPassword1!",
    }),
  );
  await assert.rejects(
    service.consume(actor, sid, {
      token,
      purpose: "setup",
      password: dashboard,
    }),
  );
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.consume(actor, sid, {
        token,
        purpose: "setup",
        password: "SyntheticMailboxPassword1!",
      }),
    ),
  );
  assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
  await assert.rejects(
    service.consume(actor, sid, {
      token,
      purpose: "setup",
      password: "SyntheticMailboxPassword1!",
    }),
  );
  await service.issue(actor, sid, mailbox, {
    purpose: "rotate",
    dashboardPassword: dashboard,
  });
  const second = delivered.at(-1)!.token;
  const next = await service.consume(actor, sid, {
    token: second,
    purpose: "rotate",
    password: "SyntheticMailboxPassword2!",
  });
  assert.equal(next.generation, 2);
  let applied = 0;
  const applier = {
    apply: async (value: { hash: string; generation: number }) => {
      applied++;
      assert.equal(value.generation, 2);
      assert.ok(
        await argon2.verify(
          value.hash.replace("{ARGON2ID}", ""),
          "SyntheticMailboxPassword2!",
        ),
      );
    },
  };
  assert.equal(await runCredentialOnce(key, applier), "idle"); // Older queued generation superseded.
  assert.equal(await runCredentialOnce(key, applier), "applied");
  assert.equal(applied, 1);
  await service.issue(actor, sid, mailbox, {
    purpose: "reset",
    dashboardPassword: dashboard,
  });
  const expired = delivered.at(-1)!.token;
  await pool.query(
    "UPDATE mailbox_credential_grants SET expires_at=NOW()-INTERVAL '1 second' WHERE digest=$1",
    [digest(expired)],
  );
  await assert.rejects(
    service.consume(actor, sid, {
      token: expired,
      purpose: "reset",
      password: "SyntheticMailboxPassword3!",
    }),
  );
  await service.issue(actor, sid, mailbox, {
    purpose: "reset",
    dashboardPassword: dashboard,
  });
  const revoked = delivered.at(-1)!.token;
  await service.issue(actor, sid, mailbox, {
    purpose: "reset",
    dashboardPassword: dashboard,
  });
  await assert.rejects(
    service.consume(actor, sid, {
      token: revoked,
      purpose: "reset",
      password: "SyntheticMailboxPassword3!",
    }),
  );
  const persisted =
    JSON.stringify(
      (
        await pool.query(
          "SELECT * FROM mailbox_credential_artifacts WHERE mailbox_id=$1",
          [mailbox],
        )
      ).rows,
    ) +
    JSON.stringify(
      (
        await pool.query(
          "SELECT * FROM mailbox_credential_requests WHERE mailbox_id=$1",
          [mailbox],
        )
      ).rows,
    ) +
    JSON.stringify(
      (
        await pool.query(
          "SELECT * FROM audit_events WHERE organization_id=$1",
          [org],
        )
      ).rows,
    );
  assert.doesNotMatch(
    persisted,
    /SyntheticMailboxPassword|argon2id|SyntheticDashboardPassword/,
  );
  assert.ok(!persisted.includes(token));
  const latest = delivered.at(-1)!.token;
  await service.consume(actor, sid, {
    token: latest,
    purpose: "reset",
    password: "SyntheticMailboxPassword3!",
  });
  assert.equal(
    await runCredentialOnce(key, {
      apply: async () => {
        throw new Error("synthetic failure");
      },
    }),
    "retry",
  );
  await pool.query(
    "UPDATE mailbox_credential_requests SET state='processing',lease_token=$2,lease_expires_at=NOW()-INTERVAL '1 second',available_at=NOW()-INTERVAL '1 second' WHERE mailbox_id=$1 AND generation=3",
    [mailbox, randomUUID()],
  );
  assert.equal(
    await runCredentialOnce(key, {
      apply: async (value) => {
        assert.equal(value.generation, 3);
      },
    }),
    "applied",
  );
  // A provider completion cannot report success after its DB lease is replaced.
  await pool.query(
    "UPDATE mailbox_credential_requests SET state='pending',lease_token=NULL,lease_expires_at=NULL WHERE mailbox_id=$1 AND generation=3",
    [mailbox],
  );
  assert.equal(
    await runCredentialOnce(key, {
      apply: async () => {
        await pool.query(
          "UPDATE mailbox_credential_requests SET lease_token=$2 WHERE mailbox_id=$1 AND generation=3",
          [mailbox, randomUUID()],
        );
      },
    }),
    "lease-lost",
  );
  // A newer desired generation arriving during the effect wins the acknowledgement.
  await pool.query(
    "UPDATE mailbox_credential_requests SET state='pending',lease_token=NULL,lease_expires_at=NULL WHERE mailbox_id=$1 AND generation=3",
    [mailbox],
  );
  assert.equal(
    await runCredentialOnce(key, {
      apply: async () => {
        await pool.query(
          "UPDATE mailboxes SET credential_generation=4 WHERE id=$1",
          [mailbox],
        );
      },
    }),
    "superseded",
  );
  const app = createApp({ mailboxCredentialService: service }),
    bearer = `Bearer ${session.accessToken}`;
  assert.equal(
    (
      await request(app)
        .post(`/api/mailbox-credentials/${mailbox}/grants`)
        .set("Authorization", bearer)
        .send({ purpose: "reset", dashboardPassword: dashboard })
    ).status,
    403,
  );
  const response = await request(app)
    .post(`/api/mailbox-credentials/${mailbox}/grants`)
    .set("Authorization", bearer)
    .set("X-Nuvomailo-CSRF", "1")
    .send({ purpose: "reset", dashboardPassword: dashboard });
  assert.equal(response.status, 202);
  assert.doesNotMatch(JSON.stringify(response.body), /token|password|hash/);
});
