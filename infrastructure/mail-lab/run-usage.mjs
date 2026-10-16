import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  compose = ["compose", "-f", "infrastructure/mail-lab/compose.yaml"];
let stage = "build-backend";
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (v) => {
      out += v;
      if (out.length > 32768) child.kill();
    });
    child.stderr.on("data", (v) => {
      err += v;
      if (err.length > 32768) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      for (const line of (out + "\n" + err).split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.passed === false && /^[a-z-]{1,40}$/.test(value.stage))
            console.error(`Usage child failed at ${value.stage}`);
        } catch {}
      }
      reject(new Error("USAGE_LAB_COMMAND_FAILED"));
    });
  });
}
async function ready() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const value = await run("docker", [
        ...compose,
        "exec",
        "-T",
        "mail",
        "python3",
        "/opt/nuvomailo-lab/probe.py",
        "ready",
      ]);
      if (value.includes('"ready": true')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("USAGE_LAB_READY_TIMEOUT");
}
async function agentReady() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const value = await run("docker", [
        ...compose,
        "run",
        "--rm",
        "worker",
        "node",
        "dist/mail-lab/client.js",
        "usage",
      ]);
      if (value.includes('"status":200')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("USAGE_AGENT_READY_TIMEOUT");
}
try {
  await run(process.execPath, [
    "backend/node_modules/typescript/bin/tsc",
    "-p",
    "backend/tsconfig.json",
  ]);
  stage = "build-worker";
  await run("docker", [...compose, "build", "worker"]);
  stage = "start-mail-db";
  await run("docker", [...compose, "up", "-d", "mail", "db"]);
  stage = "restart-agent";
  await run("docker", [...compose, "restart", "mail"]);
  await ready();
  await agentReady();
  stage = "migrate-seed";
  await run("docker", [
    ...compose,
    "run",
    "--rm",
    "worker",
    "node",
    "dist/mail-lab/client.js",
    "seed",
  ]);
  stage = "baseline";
  const baseline = await run("docker", [
    ...compose,
    "run",
    "--rm",
    "worker",
    "node",
    "dist/mail-lab/usage-conformance.js",
    "baseline",
  ]);
  await run("docker", [...compose, "restart", "mail"]);
  stage = "restart-readiness";
  await ready();
  await agentReady();
  stage = "restart-verification";
  const restart = await run("docker", [
    ...compose,
    "run",
    "--rm",
    "worker",
    "node",
    "dist/mail-lab/usage-conformance.js",
    "restart",
  ]);
  const reports = [baseline, restart].flatMap((value) =>
    value
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item?.passed),
  );
  if (reports.length !== 2) throw new Error("USAGE_LAB_REPORT_MISSING");
  console.log(
    JSON.stringify({
      passed: true,
      reports,
      publicPorts: false,
      servicesStopped: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "USAGE_LAB_FAILED",
      volumesPreserved: true,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await run("docker", [...compose, "stop", "mail", "db"]);
  } catch {
    process.exitCode = 1;
  }
}
