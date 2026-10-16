import { test } from "node:test";
import assert from "node:assert/strict";
import { DmsLabAdapter } from "../src/adapters/dms-lab.adapter.js";
import { ProvisioningWorker } from "../src/workers/provisioning.worker.js";
import { ZodError } from "zod";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  mailboxId: "55555555-5555-4555-8555-555555555555",
  address: "pilot@tenant-a.lab.invalid",
  revision: 1,
  quotaMb: 100 as const,
  status: "active" as const,
  inboundPolicy: "accept" as const,
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
test("lab provider requires explicit opt-in and validates before reading any credential material", async () => {
  const adapter = new DmsLabAdapter();
  assert.equal(adapter.mode, "local-lab");
  assert.throws(
    () => new ProvisioningWorker(adapter),
    /explicit isolated-worker opt-in/,
  );
  assert.doesNotThrow(
    () => new ProvisioningWorker(adapter, { allowLabAdapter: true }),
  );
  for (const address of [
    "pilot@customer.example",
    "../private/file",
    "pilot;command@tenant-a.lab.invalid",
  ])
    await assert.rejects(
      adapter.ensure({ ...target, address }, AbortSignal.timeout(1000)),
      ZodError,
    );
});
