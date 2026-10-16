import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const compose = ["compose", "-f", "infrastructure/mail-lab/compose.yaml"];
let stage = "start";
function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (value) => {
      out += value;
      if (out.length > 32768) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error("CUSTODY_COMMAND_FAILED")),
    );
  });
}
function json(output) {
  return output
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((value) => value && typeof value === "object");
}
async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const result = json(
        await docker([
          ...compose,
          "exec",
          "-T",
          "mail",
          "python3",
          "/opt/nuvomailo-lab/probe.py",
          "ready",
        ]),
      );
      if (result?.ready) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("MAIL_NOT_READY");
}
async function worker(phase) {
  const result = json(
    await docker([
      ...compose,
      "run",
      "--rm",
      "-T",
      "worker",
      "node",
      "dist/mail-lab/domain-custody-conformance.js",
      phase,
    ]),
  );
  if (!result?.passed) throw new Error("CONTROL_PLANE_PHASE_FAILED");
  return result;
}
async function probe(operation) {
  const result = json(
    await docker([
      ...compose,
      "exec",
      "-T",
      "mail",
      "python3",
      "/opt/nuvomailo-lab/probe.py",
      operation,
    ]),
  );
  if (!result || result.error) throw new Error("MAIL_PROBE_FAILED");
  return result;
}
try {
  await docker([...compose, "up", "-d", "mail", "db"]);
  await ready();
  stage = "active-baseline";
  await worker("prepare");
  const baseline = await probe("append");
  stage = "controller-custody";
  await worker("custody");
  const custody = await probe("custody");
  if (
    custody.imapAuthenticated ||
    custody.submissionAuthenticated ||
    custody.smtpRecipientCode !== 450 ||
    custody.messagesBefore !== custody.messagesAfter ||
    custody.messagesAfter < baseline.messages
  )
    throw new Error("CUSTODY_POLICY_MISMATCH");
  stage = "restart";
  await docker([...compose, "restart", "mail"]);
  await ready();
  const restarted = await probe("custody");
  if (
    restarted.imapAuthenticated ||
    restarted.submissionAuthenticated ||
    restarted.smtpRecipientCode !== 450 ||
    restarted.messagesBefore !== restarted.messagesAfter
  )
    throw new Error("RESTART_POLICY_MISMATCH");
  stage = "explicit-reactivation";
  await worker("prepare");
  const auth = await probe("auth");
  const inbound = await probe("inbound");
  const final = await probe("messages");
  if (
    !auth.imap ||
    !auth.smtp ||
    !inbound.smtpAccepted ||
    !inbound.deliveredWhileAuthSuspended ||
    final.messages <= baseline.messages
  )
    throw new Error("REACTIVATION_MISMATCH");
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "controller-queued-domain-custody",
        "worker-applied-suspended-and-defer",
        "imap-and-submission-denied",
        "smtp-450-before-data-with-mail-preserved",
        "restart-preserved-custody",
        "explicit-reactivation-restored-delivery",
      ],
      baselineMessages: baseline.messages,
      finalMessages: final.messages,
      syntheticOnly: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "DOMAIN_CUSTODY_LAB_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await docker([...compose, "stop", "mail", "db"]);
  } catch {
    process.exitCode = 1;
  }
}
