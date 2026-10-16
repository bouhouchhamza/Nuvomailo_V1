import pool from "../config/database.js";
import { ProvisioningWorker } from "./provisioning.worker.js";
import { log } from "../observability/logger.js";
import { env } from "../config/env.js";
import { scheduleReconciliations } from "../repositories/operations.repository.js";
import { advancePeriods } from "../services/billing.service.js";
import { recordHeartbeat } from "../services/operations-alert.service.js";
import { refreshUsageRollups } from "../services/mailbox-usage.service.js";
const worker = new ProvisioningWorker();
let stopping = false;
let nextReconciliation = 0;
const wake = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    wake.abort();
  });
try {
  log("info", "worker.started", { mode: "pending-phase-6" });
  do {
    if (Date.now() >= nextReconciliation) {
      await recordHeartbeat("provisioning-worker", `worker:${process.pid}`);
      await scheduleReconciliations(env.WORKER_RECONCILE_AFTER_MS);
      await refreshUsageRollups();
      await advancePeriods();
      nextReconciliation = Date.now() + env.WORKER_RECONCILE_INTERVAL_MS;
    }
    const result = await worker.runOnce();
    if (result !== "idle") log("info", "worker.tick", { result });
    if (process.argv.includes("--once")) break;
    if (!stopping)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, env.WORKER_POLL_MS);
        function done() {
          clearTimeout(timer);
          wake.signal.removeEventListener("abort", done);
          resolve();
        }
        wake.signal.addEventListener("abort", done, { once: true });
        if (wake.signal.aborted) done();
      });
  } while (!stopping);
} catch {
  log("error", "worker.failed", { code: "WORKER_FAILURE" });
  process.exitCode = 1;
} finally {
  await pool.end();
}
