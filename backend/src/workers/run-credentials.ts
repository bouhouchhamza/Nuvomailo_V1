import { readFile } from "node:fs/promises";
import pool from "../config/database.js";
import { env } from "../config/env.js";
import { LocalCredentialApplier } from "../adapters/credential-applier.adapter.js";
import { runCredentialOnce } from "../services/mailbox-credential.service.js";
// Separate explicit synthetic executable; ordinary worker selection is unchanged.
try {
  if (env.NODE_ENV !== "test" || !process.argv.includes("--lab"))
    throw new Error("LAB_ONLY");
  const key = Buffer.from(
    (await readFile("/run/nuvomailo-credential-vault/key", "utf8")).trim(),
    "hex",
  );
  if (key.length !== 32) throw new Error("KEY_UNAVAILABLE");
  const applier = new LocalCredentialApplier();
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });
  do {
    const state = await runCredentialOnce(key, applier);
    console.log(JSON.stringify({ event: "credential_tick", state }));
    if (process.argv.includes("--once")) break;
    if (state === "idle")
      await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!stopped);
} catch {
  console.error('{"event":"credential_worker_failed"}');
  process.exitCode = 1;
} finally {
  await pool.end();
}
