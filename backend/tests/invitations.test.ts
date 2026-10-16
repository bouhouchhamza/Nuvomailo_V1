import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import * as invitations from "../src/services/invitation.service.js";
import { createOrganization } from "../src/services/tenant.service.js";
const owner = randomUUID(),
  member = randomUUID(),
  outsider = randomUUID();
let org: string;
after(async () => {
  if (org) await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, member, outsider],
  ]);
  await pool.end();
});
test("invitations require verified recipient, reject tenant substitution/replay/expiry/revocation and transfer ownership atomically", async () => {
  for (const id of [owner, member, outsider])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,'synthetic',CASE WHEN $3 THEN NOW() END)",
      [id, `${id}@example.test`, id !== member],
    );
  org = (
    await createOrganization(owner, {
      name: "Invitations fixture",
      slug: randomUUID(),
    })
  ).id;
  const invite = await invitations.invite(owner, org, {
    email: `${member}@example.test`,
    role: "admin",
  });
  await assert.rejects(
    invitations.invite(outsider, org, {
      email: "outsider@example.test",
      role: "admin",
    }),
  );
  await assert.rejects(invitations.accept(outsider, invite.id));
  await assert.rejects(invitations.accept(member, invite.id));
  assert.deepEqual(await invitations.inbox(member), []);
  await pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
    member,
  ]);
  assert.equal((await invitations.inbox(member)).length, 1);
  const accepted = await Promise.allSettled([
    invitations.accept(member, invite.id),
    invitations.accept(member, invite.id),
  ]);
  assert.equal(accepted.filter((v) => v.status === "fulfilled").length, 1);
  await assert.rejects(invitations.leave(owner, org));
  await assert.rejects(invitations.transfer(member, org, { userId: owner }));
  await invitations.transfer(owner, org, { userId: member });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM memberships WHERE organization_id=$1 AND role='owner'",
        [org],
      )
    ).rows[0]!.n,
    1,
  );
  await assert.rejects(
    invitations.invite(owner, org, {
      email: "blocked@example.test",
      role: "admin",
    }),
  );
  await invitations.leave(owner, org);
  const expired = await invitations.invite(member, org, {
    email: `${outsider}@example.test`,
    role: "member",
  });
  await pool.query(
    "UPDATE membership_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(invitations.accept(outsider, expired.id));
  const revoked = await invitations.invite(member, org, {
    email: `${outsider}@example.test`,
    role: "member",
  });
  await invitations.revoke(member, org, revoked.id);
  await assert.rejects(invitations.accept(outsider, revoked.id));
});
