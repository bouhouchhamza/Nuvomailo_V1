import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runner } from "node-pg-migrate";
import pool from "../src/config/database.js";
import { readdir } from "node:fs/promises";

test("migrations preserve legacy intent, apply idempotently and roll back in an isolated schema", async () => {
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^migration_test_[a-f0-9]{32}$/);
  const client = await pool.connect();
  let created = false;
  try {
    // Generated identifier, never a caller-provided schema or the public schema.
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const options = {
      dbClient: client,
      schema,
      migrationsTable: "pgmigrations",
      dir: "migrations",
      log: () => {},
      verbose: false,
    };
    const count = (await readdir("migrations")).filter((name) =>
      name.endsWith(".ts"),
    ).length;
    const baseline = await runner({ ...options, direction: "up", count: 3 });
    assert.equal(baseline.length, 3);
    const user = (
      await client.query(
        "INSERT INTO users(email,password_hash) VALUES ('migration@example.test','test') RETURNING id",
      )
    ).rows[0]!;
    const org = (
      await client.query(
        "INSERT INTO organizations(name,slug) VALUES ('Legacy migration','legacy-migration') RETURNING id",
      )
    ).rows[0]!;
    await client.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES ($1,$2,'owner')",
      [user.id, org.id],
    );
    const domain = (
      await client.query(
        "INSERT INTO domains(organization_id,name,verification_token) VALUES ($1,'migration.example','test') RETURNING id",
        [org.id],
      )
    ).rows[0]!;
    const box = (
      await client.query(
        "INSERT INTO mailboxes(domain_id,local_part) VALUES ($1,'legacy') RETURNING id",
        [domain.id],
      )
    ).rows[0]!;
    for (const [index, operation] of [
      "create",
      "suspend",
      "set_quota",
      "resume",
    ].entries())
      await client.query(
        "INSERT INTO provisioning_requests(mailbox_id,operation,quota_mb,created_at) VALUES ($1,$2,$3,'2026-01-01'::timestamptz+($4::integer*INTERVAL '1 second'))",
        [box.id, operation, index < 2 ? 100 : 200, index],
      );
    const applied = await runner({ ...options, direction: "up" });
    assert.equal(applied.length, count - 3);
    const jobs = (
      await client.query(
        "SELECT desired_status,revision FROM provisioning_requests ORDER BY revision",
      )
    ).rows;
    assert.deepEqual(
      jobs.map((j) => j.desired_status),
      ["active", "suspended", "suspended", "active"],
    );
    const migrated = (
      await client.query(
        "SELECT desired_revision,desired_status,observed_status,applied_revision FROM mailboxes WHERE id=$1",
        [box.id],
      )
    ).rows[0]!;
    assert.deepEqual(migrated, {
      desired_revision: 4,
      desired_status: "active",
      observed_status: "unknown",
      applied_revision: 0,
    });
    const tables = (
      await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
        [schema],
      )
    ).rows.map((r) => r.table_name);
    for (const table of [
      "users",
      "organizations",
      "memberships",
      "domains",
      "mailboxes",
      "provisioning_requests",
    ])
      assert.ok(tables.includes(table));
    assert.equal((await runner({ ...options, direction: "up" })).length, 0);
    assert.equal(
      (await runner({ ...options, direction: "down", count })).length,
      count,
    );
    const remaining = (
      await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
        [schema],
      )
    ).rows;
    assert.deepEqual(
      remaining.map((r) => r.table_name),
      ["pgmigrations"],
    );
  } finally {
    // A failed transactional migration leaves this dedicated client aborted.
    // Roll it back so cleanup cannot mask the migration's original error.
    await client.query("ROLLBACK").catch(() => undefined);
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
