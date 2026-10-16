import pool from "../config/database.js";
import { env } from "../config/env.js";
import { LocalRoutingApplier } from "../adapters/routing-applier.adapter.js";
import { runRoutingOnce } from "../services/mail-routing.service.js";
try {
  if (env.NODE_ENV !== "test" || !process.argv.includes("--lab"))
    throw new Error("LAB_ONLY");
  const applier = new LocalRoutingApplier();
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });
  do {
    const state = await runRoutingOnce(applier);
    console.log(JSON.stringify({ event: "routing_tick", state }));
    if (process.argv.includes("--once")) break;
    if (state === "idle")
      await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!stopped);
} catch {
  console.error('{"event":"routing_worker_failed"}');
  process.exitCode = 1;
} finally {
  await pool.end();
}
