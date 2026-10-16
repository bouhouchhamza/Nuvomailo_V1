import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const compose = ["compose", "-f", "infrastructure/mail-lab/compose.yaml"];
const testFile =
  process.argv[2] === "routing"
    ? "routing-conformance.js"
    : "webmail-conformance.js";
function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (value) => {
      out += value;
      if (out.length > 16384) child.kill();
    });
    child.stderr.on("data", (value) => {
      err += value;
      if (err.length > 16384) child.kill();
    });
    child.on("error", () => reject(new Error("DOCKER_PROCESS_FAILED")));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      if (args.includes(`dist/mail-lab/${testFile}`)) {
        for (const line of err.split("\n")) {
          try {
            const report = JSON.parse(line);
            if (report.passed === false && /^[a-z-]{1,30}$/.test(report.stage))
              console.error(`Webmail check failed at stage: ${report.stage}`);
          } catch {}
        }
      }
      reject(new Error("LAB_COMMAND_FAILED"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
try {
  await run([...compose, "up", "-d", "mail", "db"]);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = JSON.parse(
        await run([
          ...compose,
          "exec",
          "-T",
          "mail",
          "python3",
          "/opt/nuvomailo-lab/probe.py",
          "ready",
        ]),
      );
      if (result.ready) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("MAIL_NOT_READY");
  await run([
    ...compose,
    "run",
    "--rm",
    "-T",
    "worker",
    "node",
    "dist/mail-lab/client.js",
    "seed",
  ]);
  // Fixed, synthetic fixture only. Capture directly; never echo or persist this output.
  const credentials = await run([
    ...compose,
    "exec",
    "-T",
    "mail",
    "python3",
    "-c",
    testFile === "routing-conformance.js"
      ? "import sys,json; sys.path.insert(0,'/opt/nuvomailo-lab'); from common import password; a='pilot@tenant-a.lab.invalid'; b='partial@tenant-a.lab.invalid'; print(json.dumps({'address':a,'password':password(a),'peer':{'address':b,'password':password(b)}}))"
      : "import sys,json; sys.path.insert(0,'/opt/nuvomailo-lab'); from common import password; a='pilot@tenant-a.lab.invalid'; print(json.dumps({'address':a,'password':password(a)}))",
  ]);
  const report = await run(
    [
      ...compose,
      "run",
      "--rm",
      "-T",
      "worker",
      "node",
      `dist/mail-lab/${testFile}`,
    ],
    credentials,
  );
  const parsed = report
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((item) => item?.passed === true);
  if (parsed.passed !== true) throw new Error("INVALID_REPORT");
  console.log(JSON.stringify(parsed));
} catch {
  console.error(
    "Synthetic webmail conformance failed; credentials and protocol output suppressed.",
  );
  process.exitCode = 1;
}
