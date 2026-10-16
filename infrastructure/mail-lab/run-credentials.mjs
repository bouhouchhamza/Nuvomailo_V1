import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  compose = ["compose", "-f", "infrastructure/mail-lab/compose.yaml"];
function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...compose, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (v) => {
      out += v;
      if (out.length > 16384) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error("LAB_COMMAND_FAILED")),
    );
  });
}
async function ready() {
  for (let i = 0; i < 30; i++) {
    try {
      const report = JSON.parse(
        await command([
          "exec",
          "-T",
          "mail",
          "python3",
          "/opt/nuvomailo-lab/probe.py",
          "ready",
        ]),
      );
      if (report.ready) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("MAIL_READINESS_TIMEOUT");
}
try {
  await command(["up", "-d", "mail", "db", "credential-broker"]);
  await ready();
  await command([
    "run",
    "--rm",
    "-T",
    "worker",
    "node",
    "dist/mail-lab/client.js",
    "seed",
  ]);
  await new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        ...compose,
        "run",
        "--rm",
        "-T",
        "worker",
        "node",
        "dist/mail-lab/credential-conformance.js",
        "restart-check",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "",
      passed = false,
      restarting = false;
    child.stderr.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.passed === false && /^[a-z-]{1,40}$/.test(value.stage))
            console.error(`Credential check failed at ${value.stage}`);
        } catch {}
      }
    });
    child.stdout.on("data", (data) => {
      buffer += data;
      if (buffer.length > 16384) {
        child.kill();
        return;
      }
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        try {
          const value = JSON.parse(line);
          if (value.checkpoint === "restart-required" && !restarting) {
            restarting = true;
            (async () => {
              await command(["restart", "mail", "credential-broker"]);
              await ready();
              child.stdin.end("resume\n");
            })().catch(() => {
              child.kill();
              reject(new Error("RESTART_FAILED"));
            });
          } else if (value.passed === true) {
            passed = true;
            console.log(JSON.stringify(value));
          }
        } catch {}
      }
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && passed
        ? resolve()
        : reject(new Error("CREDENTIAL_TEST_FAILED")),
    );
  });
  console.log(
    (
      await command([
        "run",
        "--rm",
        "-T",
        "--user",
        "1001:3000",
        "worker",
        "node",
        "dist/mail-lab/credential-conformance.js",
        "denied-peer",
      ])
    ).trim(),
  );
} catch {
  console.error(
    "Synthetic credential conformance failed; secret/provider output suppressed.",
  );
  process.exitCode = 1;
}
