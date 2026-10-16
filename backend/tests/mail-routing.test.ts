import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { createOrganization } from "../src/services/tenant.service.js";
import { createMailbox } from "../src/services/mailbox.service.js";
import {
  saveRoute,
  listRoutes,
  runRoutingOnce,
} from "../src/services/mail-routing.service.js";
const actor = randomUUID(),
  outsider = randomUUID();
let org: string;
after(async () => {
  if (org) {
    await pool.query(
      "DELETE FROM mailboxes WHERE domain_id IN(SELECT id FROM domains WHERE organization_id=$1)",
      [org],
    );
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  }
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [actor, outsider],
  ]);
  await pool.end();
});
test("internal routing protects tenant/address ownership, prevents alias loops and supersedes queued snapshots", async () => {
  for (const id of [actor, outsider])
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",
      [id, `${id}@example.test`],
    );
  org = (
    await createOrganization(actor, {
      name: "Routing tests",
      slug: randomUUID(),
    })
  ).id;
  const domain = (
    await pool.query(
      "INSERT INTO domains(organization_id,name,verification_token,verification_status,mail_activation) VALUES($1,$2,'synthetic','verified','local-lab') RETURNING id",
      [org, `${org}.example.test`],
    )
  ).rows[0]!.id;
  const mailbox = await createMailbox(actor, org, {
    domainId: domain,
    localPart: "target",
    quotaMb: 100,
  });
  const route = {
    domainId: domain,
    localPart: "alias",
    kind: "alias",
    targets: [mailbox.id],
  };
  await assert.rejects(saveRoute(outsider, org, route));
  await assert.rejects(
    saveRoute(actor, org, { ...route, localPart: "target" }),
  );
  await assert.rejects(
    saveRoute(actor, org, { ...route, targets: [randomUUID()] }),
  );
  await assert.rejects(
    saveRoute(actor, org, { ...route, targets: [mailbox.id, mailbox.id] }),
  );
  const first = await saveRoute(actor, org, route);
  await assert.rejects(
    createMailbox(actor, org, {
      domainId: domain,
      localPart: "alias",
      quotaMb: 100,
    }),
  );
  await saveRoute(actor, org, { ...route, kind: "forward" });
  const applied: { generation: number }[] = [];
  assert.equal(
    await runRoutingOnce({
      apply: async (target) => {
        applied.push(target);
      },
    }),
    "idle",
  );
  assert.equal(
    await runRoutingOnce({
      apply: async (target) => {
        applied.push(target);
      },
    }),
    "applied",
  );
  assert.equal(applied[0]!.generation, 2);
  const disabled = await saveRoute(actor, org, { ...route, enabled: false });
  assert.equal(disabled.state, "pending");
  await runRoutingOnce({
    apply: async (target) => {
      assert.deepEqual(target.routes, []);
    },
  });
  await assert.rejects(
    createMailbox(actor, org, {
      domainId: domain,
      localPart: "alias",
      quotaMb: 100,
    }),
  );
  assert.equal((await listRoutes(actor, org)).length, 1);
  const race = await Promise.allSettled([
    saveRoute(actor, org, { ...route, localPart: "race" }),
    createMailbox(actor, org, {
      domainId: domain,
      localPart: "race",
      quotaMb: 100,
    }),
  ]);
  assert.equal(race.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(
    (
      await pool.query("SELECT state FROM mail_routing_requests WHERE id=$1", [
        first.requestId,
      ])
    ).rows[0]!.state,
    "superseded",
  );
});
