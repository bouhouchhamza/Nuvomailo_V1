import pool from "../config/database.js";
import {
  recordHeartbeat,
  runOperationsAlertOnce,
  SyntheticOperationsAlertTransport,
} from "../services/operations-alert.service.js";

if (!process.argv.includes("--local-synthetic"))
  throw new Error(
    "Operations alerts are unconfigured; explicit --local-synthetic required",
  );
try {
  await recordHeartbeat("notification-worker", `alerts:${process.pid}`);
  const results: string[] = [];
  let result: Awaited<ReturnType<typeof runOperationsAlertOnce>>;
  while (
    (result = await runOperationsAlertOnce(
      new SyntheticOperationsAlertTransport(),
      { allowSynthetic: true },
    )) !== "idle"
  )
    results.push(result);
  console.log(
    JSON.stringify({ event: "local_alert_delivery_completed", results }),
  );
} finally {
  await pool.end();
}
