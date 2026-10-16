// Operator-only synthetic compatibility probe; never imported by API/worker code.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const argon2 = require("argon2");
const password = randomBytes(48).toString("hex");
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
const child = spawn(
  "docker",
  [
    "compose",
    "-f",
    "infrastructure/mail-lab/compose.yaml",
    "exec",
    "-T",
    "mail",
    "python3",
    "/opt/nuvomailo-lab/probe.py",
    "argon-import",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
const chunks = [];
child.stdout.on("data", (chunk) => chunks.push(chunk));
// Provider stderr is deliberately not printed or serialized.
child.stderr.resume();
child.stdin.end(JSON.stringify({ password, hash }));
const code = await new Promise((resolve, reject) => {
  child.on("error", () =>
    reject(new Error("LAB_COMPATIBILITY_TRANSPORT_FAILED")),
  );
  child.on("close", resolve);
});
if (code !== 0) {
  console.error(JSON.stringify({ error: "NODE_ARGON_COMPATIBILITY_FAILED" }));
  process.exitCode = 1;
} else {
  const result = JSON.parse(Buffer.concat(chunks).toString());
  console.log(JSON.stringify(result));
  if (!result.canonicalParameterOrderAuthenticated) process.exitCode = 1;
}
