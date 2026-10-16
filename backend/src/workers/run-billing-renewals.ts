import pool from "../config/database.js";
import {
  runRenewalOnce,
  SyntheticRenewalProvider,
  type RenewalOutcome,
} from "../services/billing.service.js";
import { log } from "../observability/logger.js";

const allowed = process.argv.includes("--local-synthetic");
const outcome = process.argv.includes("--outcome=failed")
  ? ("failed" as RenewalOutcome)
  : ("succeeded" as RenewalOutcome);

if (!allowed) throw new Error("Local synthetic renewal requires explicit opt-in");
try {
  const result = await runRenewalOnce(new SyntheticRenewalProvider(outcome), {
    allowSynthetic: true,
  });
  log("info", "billing.synthetic_renewal_completed", { result });
} catch {
  log("error", "billing.synthetic_renewal_failed", {
    code: "SYNTHETIC_RENEWAL_FAILURE",
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
