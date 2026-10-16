import { DmsLabAdapter } from "../adapters/dms-lab.adapter.js";
import { ProvisioningWorker } from "../workers/provisioning.worker.js";
import { randomUUID } from "node:crypto";
import type { MailboxTarget } from "../services/provisioning.adapter.js";
import pool from "../config/database.js";
const org = "11111111-1111-4111-8111-111111111111";
const adapter = new DmsLabAdapter();
const target: MailboxTarget = {
  organizationId: org,
  mailboxId: "55555555-5555-4555-8555-555555555555",
  address: "pilot@tenant-a.lab.invalid",
  revision: 1,
  quotaMb: 100,
  status: "active",
  inboundPolicy: "accept",
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
try {
  const mode = process.argv[2];
  if (mode === "tick")
    console.log(
      JSON.stringify({
        result: await new ProvisioningWorker(adapter, {
          organizationId: org,
          timeoutMs: 30000,
          leaseMs: 120000,
          allowLabAdapter: true,
        }).runOnce(),
      }),
    );
  else if (mode === "ensure")
    console.log(
      JSON.stringify(
        await adapter.ensure(
          {
            ...target,
            idempotencyKey: process.argv[3] ?? target.idempotencyKey,
            revision: Number(process.argv[4] ?? 1),
          },
          AbortSignal.timeout(35000),
        ),
      ),
    );
  else if (mode === "inspect") {
    const { rpc } = await import("./rpc.js");
    console.log(JSON.stringify(await rpc("/v1/inspect", target)));
  } else if (mode === "usage") {
    const { rpc } = await import("./rpc.js");
    console.log(
      JSON.stringify(
        await rpc("/v1/usage", {
          organizationId: target.organizationId,
          mailboxId: target.mailboxId,
          address: target.address,
        }),
      ),
    );
  } else if (mode === "seed") {
    const { runner } = await import("node-pg-migrate");
    const { readFile } = await import("node:fs/promises");
    const client = await pool.connect();
    try {
      await runner({
        dbClient: client,
        dir: "migrations",
        migrationsTable: "pgmigrations",
        direction: "up",
        log: () => {},
      });
      await client.query(await readFile("/lab/seed.sql", "utf8"));
    } finally {
      client.release();
    }
    console.log(JSON.stringify({ seeded: true }));
  } else throw new Error("Unknown lab operation");
} catch {
  console.error(JSON.stringify({ error: "LAB_OPERATION_FAILED" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
