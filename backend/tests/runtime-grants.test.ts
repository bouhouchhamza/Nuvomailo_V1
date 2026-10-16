import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runner } from "node-pg-migrate";
import pool from "../src/config/database.js";
test("reviewed runtime roles separate worker identity data and keep audit/staff grants restricted", async () => {
  const suffix = randomUUID().replaceAll("-", ""),
    schema = `grants_test_${suffix}`,
    api = `api_test_${suffix}`,
    worker = `worker_test_${suffix}`,
    notification = `notification_test_${suffix}`;
  assert.match(schema, /^grants_test_[a-f0-9]{32}$/);
  const roles: string[] = [];
  const client = await pool.connect();
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await runner({
      dbClient: client,
      schema,
      // This fixture migrates a unique schema, independently of application migrations.
      lockValue: Number.parseInt(suffix.slice(0, 7), 16),
      migrationsTable: "pgmigrations",
      dir: "migrations",
      direction: "up",
      log: () => {},
    });
    for (const role of [api, worker, notification]) {
      await client.query(
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      roles.push(role);
    }
    let sql = await readFile(
      "../infrastructure/production/runtime-grants.sql",
      "utf8",
    );
    sql = sql
      .replaceAll("SCHEMA public", `SCHEMA "${schema}"`)
      .replaceAll("nuvomailo_api", `"${api}"`)
      .replaceAll("nuvomailo_worker", `"${worker}"`)
      .replaceAll("nuvomailo_notification", `"${notification}"`);
    await client.query(sql);
    const org = (
      await client.query(
        "INSERT INTO organizations(name,slug) VALUES('Runtime grants','runtime-test') RETURNING id",
      )
    ).rows[0]!.id;
    await client.query(`SET ROLE "${worker}"`);
    await client.query("SELECT id FROM mailboxes");
    await client.query("SELECT id FROM mailbox_usage_requests");
    await client.query(
      "SELECT organization_id FROM organization_usage_rollups",
    );
    await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended(id::text,4759)) FROM organizations LIMIT 1",
    );
    await client.query("SELECT id FROM billing_renewal_requests");
    await client.query(
      "SELECT request_id FROM synthetic_billing_renewal_effects",
    );
    await client.query(
      `INSERT INTO platform_heartbeats(component,instance_digest,state,expires_at)
      VALUES('provisioning-worker',$1,'healthy',NOW()+INTERVAL '1 minute')`,
      ["c".repeat(64)],
    );
    for (const table of [
      "users",
      "identity_sessions",
      "mfa_recovery_codes",
      "mailbox_credential_artifacts",
      "platform_staff",
      "support_grants",
      "platform_incidents",
      "platform_alert_outbox",
      "synthetic_alert_deliveries",
      "released_domain_claims",
      "domain_revalidation_requests",
      "domain_notification_outbox",
      "webmail_contacts",
      "webmail_send_attempts",
    ])
      await assert.rejects(
        client.query(`SELECT * FROM ${table}`),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "42501",
      );
    await client.query(
      "INSERT INTO audit_events(organization_id,action) VALUES($1,'worker.fixture')",
      [org],
    );
    await assert.rejects(client.query("DELETE FROM audit_events"));
    await assert.rejects(
      client.query("UPDATE platform_staff SET role='operator'"),
    );
    await client.query("RESET ROLE");
    await client.query(`SET ROLE "${notification}"`);
    await client.query("SELECT id,email,status,email_verified_at FROM users");
    await client.query("SELECT user_id,organization_id,role FROM memberships");
    await client.query("SELECT id FROM domain_revalidation_requests");
    await client.query("SELECT id FROM domain_notification_outbox");
    await client.query("SELECT id FROM platform_alert_outbox");
    await assert.rejects(
      client.query("SELECT * FROM billing_renewal_requests"),
    );
    await assert.rejects(
      client.query("SELECT * FROM synthetic_billing_renewal_effects"),
    );
    await client.query(
      "UPDATE platform_alert_outbox SET state=state WHERE false",
    );
    await client.query(
      `INSERT INTO platform_heartbeats(component,instance_digest,state,expires_at)
      VALUES('notification-worker',$1,'healthy',NOW()+INTERVAL '1 minute')`,
      ["a".repeat(64)],
    );
    await client.query("SELECT id FROM mailboxes");
    await assert.rejects(client.query("SELECT * FROM webmail_contacts"));
    await assert.rejects(client.query("SELECT * FROM webmail_send_attempts"));
    await assert.rejects(client.query("SELECT password_hash FROM users"));
    await assert.rejects(client.query("SELECT * FROM identity_sessions"));
    await client.query(
      "UPDATE domains SET revalidation_due_at=revalidation_due_at WHERE false",
    );
    await client.query(
      "UPDATE mailboxes SET desired_inbound_policy=desired_inbound_policy WHERE false",
    );
    await client.query("RESET ROLE");
    await client.query(`SET ROLE "${api}"`);
    await client.query("SELECT id FROM users");
    await client.query("SELECT id FROM mailbox_usage_requests");
    await client.query(
      "SELECT organization_id FROM organization_usage_rollups",
    );
    await client.query("SELECT id FROM billing_renewal_requests");
    await assert.rejects(
      client.query("SELECT * FROM synthetic_billing_renewal_effects"),
    );
    await client.query("SELECT id FROM released_domain_claims");
    await client.query("SELECT id FROM domain_revalidation_requests");
    await client.query("SELECT id FROM domain_notification_outbox");
    await client.query("SELECT id FROM platform_alert_outbox");
    await client.query(
      `INSERT INTO platform_heartbeats(component,instance_digest,state,expires_at)
      VALUES('control-plane',$1,'healthy',NOW()+INTERVAL '1 minute')`,
      ["b".repeat(64)],
    );
    await client.query("SELECT id FROM webmail_contacts");
    await client.query(
      "UPDATE webmail_contacts SET display_name=display_name WHERE false",
    );
    await client.query("DELETE FROM webmail_contacts WHERE false");
    await client.query("SELECT id FROM webmail_send_attempts");
    await client.query(
      "UPDATE webmail_send_attempts SET state=state WHERE false",
    );
    await assert.rejects(
      client.query("SELECT * FROM mailbox_credential_artifacts"),
    );
    await assert.rejects(client.query("DELETE FROM audit_events"));
    await assert.rejects(
      client.query("UPDATE platform_staff SET role='operator'"),
    );
    await client.query("RESET ROLE");
    const actor = randomUUID(),
      domain = randomUUID(),
      mailbox = randomUUID(),
      attempt = randomUUID();
    await client.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",
      [actor, `${actor}@example.test`],
    );
    await client.query(
      "INSERT INTO domains(id,organization_id,name,verification_token) VALUES($1,$2,$3,'synthetic')",
      [domain, org, `${domain}.example.test`],
    );
    await client.query(
      "INSERT INTO mailboxes(id,domain_id,local_part) VALUES($1,$2,'rollback')",
      [mailbox, domain],
    );
    await client.query(`SET ROLE "${api}"`);
    await client.query(
      `INSERT INTO webmail_send_attempts(id,mailbox_id,user_id,idempotency_key,request_digest,state)
      VALUES($1,$2,$3,$4,$5,'uncertain')`,
      [attempt, mailbox, actor, randomUUID(), "d".repeat(64)],
    );
    await client.query(
      "UPDATE webmail_send_attempts SET resolution='confirmed_not_sent',resolved_at=NOW() WHERE id=$1",
      [attempt],
    );
    await assert.rejects(
      client.query("DELETE FROM webmail_send_attempts WHERE id=$1", [attempt]),
    );
    await client.query("RESET ROLE");
    await client.query(`SET ROLE "${worker}"`);
    await assert.rejects(
      client.query(
        "UPDATE webmail_send_attempts SET resolution=NULL WHERE id=$1",
        [attempt],
      ),
    );
    await client.query("RESET ROLE");
    // Re-running forward migrations on an already-current schema must preserve data.
    await runner({
      dbClient: client,
      schema,
      lockValue: Number.parseInt(suffix.slice(0, 7), 16),
      migrationsTable: "pgmigrations",
      dir: "migrations",
      direction: "up",
      log: () => {},
    });
    const preserved = (
      await client.query(
        "SELECT state,resolution,resolved_at FROM webmail_send_attempts WHERE id=$1",
        [attempt],
      )
    ).rows[0];
    assert.equal(preserved.state, "uncertain");
    assert.equal(preserved.resolution, "confirmed_not_sent");
    assert.ok(preserved.resolved_at);
  } finally {
    await client.query("RESET ROLE");
    await client.query("SET search_path TO public");
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    for (const role of roles) await client.query(`DROP ROLE "${role}"`);
    client.release();
    await pool.end();
  }
});
