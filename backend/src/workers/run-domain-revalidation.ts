import pool from "../config/database.js";
import { SyntheticDomainNotificationTransport } from "../services/domain-notification.adapter.js";
import {
  runDomainNotificationOnce,
  runRevalidationOnce,
  scheduleDueRevalidations,
} from "../services/domain-revalidation-worker.service.js";
import { recordHeartbeat } from "../services/operations-alert.service.js";

if (!process.argv.includes("--local-synthetic"))
  throw new Error(
    "Domain notifications are unconfigured; explicit --local-synthetic required",
  );
try {
  await recordHeartbeat("domain-scheduler", `domain:${process.pid}`);
  const scheduled = await scheduleDueRevalidations();
  const revalidation: string[] = [];
  let result: Awaited<ReturnType<typeof runRevalidationOnce>>;
  while ((result = await runRevalidationOnce()) !== "idle")
    revalidation.push(result);
  const notification: string[] = [];
  const transport = new SyntheticDomainNotificationTransport();
  let delivery: Awaited<ReturnType<typeof runDomainNotificationOnce>>;
  while (
    (delivery = await runDomainNotificationOnce(transport, {
      allowSynthetic: true,
    })) !== "idle"
  )
    notification.push(delivery);
  console.log(
    JSON.stringify({
      event: "local_domain_revalidation_completed",
      scheduled,
      revalidation,
      notification,
    }),
  );
} finally {
  await pool.end();
}
