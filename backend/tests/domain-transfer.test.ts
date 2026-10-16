import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import pool from "../src/config/database.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { createDomain } from "../src/services/domain.service.js";
import { transferEmptyDomain } from "../src/services/domain-transfer.service.js";
const actor = randomUUID(),
  other = randomUUID(),
  password = "SyntheticDomainTransfer123!";
const organizations: string[] = [];
after(async () => {
  for (const org of organizations)
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [actor, other],
  ]);
  await pool.end();
});
test("empty-domain transfer requires both owners and reproof; irreversible custody marker blocks activated domains", async () => {
  for (const id of [actor, other])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,$3,NOW())",
      [id, `${id}@example.test`, await argon2.hash(password)],
    );
  for (let i = 0; i < 2; i++)
    organizations.push(
      (
        await createOrganization(actor, {
          name: "Domain custody",
          slug: randomUUID(),
        })
      ).id,
    );
  const [source, target] = organizations as [string, string];
  const domain = await createDomain(actor, source, {
    name: `${randomUUID()}.example.test`,
  });
  await assert.rejects(
    transferEmptyDomain(other, source, domain.id, {
      targetOrganizationId: target,
      dashboardPassword: password,
    }),
  );
  await assert.rejects(
    transferEmptyDomain(actor, source, domain.id, {
      targetOrganizationId: target,
      dashboardPassword: "wrong",
    }),
  );
  await transferEmptyDomain(actor, source, domain.id, {
    targetOrganizationId: target,
    dashboardPassword: password,
  });
  const moved = (
    await pool.query("SELECT * FROM domains WHERE id=$1", [domain.id])
  ).rows[0]!;
  assert.equal(moved.organization_id, target);
  assert.equal(moved.verification_status, "pending");
  assert.notEqual(moved.verification_token, domain.verification_token);
  await pool.query(
    "UPDATE domains SET mail_activation='local-lab' WHERE id=$1",
    [domain.id],
  );
  await pool.query(
    "UPDATE domains SET mail_activation='disabled',mail_ever_activated=FALSE WHERE id=$1",
    [domain.id],
  );
  assert.equal(
    (
      await pool.query("SELECT mail_ever_activated FROM domains WHERE id=$1", [
        domain.id,
      ])
    ).rows[0]!.mail_ever_activated,
    true,
  );
  await assert.rejects(
    transferEmptyDomain(actor, target, domain.id, {
      targetOrganizationId: source,
      dashboardPassword: password,
    }),
  );
  const inserted = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,mail_activation) VALUES($1,$2,'synthetic','local-lab') RETURNING id",
      [source, `${randomUUID()}.example.test`],
    )
  ).rows[0]!.id;
  await pool.query(
    "UPDATE domains SET mail_activation='disabled',mail_ever_activated=FALSE WHERE id=$1",
    [inserted],
  );
  await assert.rejects(
    transferEmptyDomain(actor, source, inserted, {
      targetOrganizationId: target,
      dashboardPassword: password,
    }),
  );
});
