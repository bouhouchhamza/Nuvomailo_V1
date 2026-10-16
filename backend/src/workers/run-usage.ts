import pool from "../config/database.js";
import { DmsUsageLabAdapter } from "../adapters/dms-usage-lab.adapter.js";
import {
  runUsageOnce,
  scheduleUsage,
} from "../services/mailbox-usage.service.js";

if (!process.argv.includes("--lab"))
  throw new Error(
    "Usage provider is unconfigured; explicit isolated --lab required",
  );
try {
  await scheduleUsage(0, 50);
  while (
    (await runUsageOnce(new DmsUsageLabAdapter(), {
      allowLab: true,
      leaseMs: 60_000,
      timeoutMs: 30_000,
    })) !== "idle"
  ) {}
} finally {
  await pool.end();
}
