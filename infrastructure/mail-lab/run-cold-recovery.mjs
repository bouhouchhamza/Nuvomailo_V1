import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  id = process.argv[2];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id ?? "",
  )
)
  throw new Error("Existing synthetic snapshot UUID required");
const args = [
  "compose",
  "-p",
  `nuvomailo-coordinated-${id.slice(0, 8)}`,
  "-f",
  "infrastructure/mail-lab/coordinated-backup.compose.yaml",
];
function docker(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args, ...command], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (v) => {
      out += v;
      if (out.length > 16384) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error("COLD_RESTORE_COMMAND_FAILED")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
try {
  await docker(["up", "-d", "--wait", "db", "mail"]);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      if (
        JSON.parse(
          await docker([
            "exec",
            "-T",
            "mail",
            "python3",
            "/opt/nuvomailo-lab/probe.py",
            "ready",
          ]),
        ).ready
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("MAIL_NOT_READY");
  const secret = await docker([
    "exec",
    "-T",
    "mail",
    "python3",
    "-c",
    "import sys,json; sys.path.insert(0,'/opt/nuvomailo-lab'); from common import password; a='pilot@tenant-a.lab.invalid'; print(json.dumps({'address':a,'password':password(a)}))",
  ]);
  const result = await docker(
    [
      "run",
      "--rm",
      "-T",
      "--entrypoint",
      "node",
      "verify",
      "dist/mail-lab/cold-restore-conformance.js",
    ],
    secret,
  );
  const report = result
    .split("\n")
    .map((v) => {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    })
    .find((v) => v?.passed === true);
  if (!report) throw new Error("INVALID_COLD_REPORT");
  console.log(JSON.stringify(report));
} catch {
  console.error('{"passed":false,"code":"COLD_RECOVERY_FAILED"}');
  process.exitCode = 1;
} finally {
  try {
    await docker(["stop", "mail", "db"]);
  } catch {
    process.exitCode = 1;
  }
}
