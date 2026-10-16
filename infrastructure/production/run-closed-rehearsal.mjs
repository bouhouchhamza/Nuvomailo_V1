import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  id = process.argv[2] ?? randomUUID(),
  project = `nuvomailo-rehearsal-${id.slice(0, 8)}`,
  directory = join(root, "infrastructure", "production", "secrets", id);
let stage = "synthetic-secrets";
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
  throw new Error("INVALID_REHEARSAL_ID");
const environment = {
    ...process.env,
    SECRETS_DIR: directory,
    PUBLIC_ORIGIN: "https://nuvomailo.rehearsal.invalid",
  },
  compose = [
    "compose",
    "-p",
    project,
    "-f",
    "infrastructure/production/compose.yaml",
  ];
function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (data) => {
      out += data;
      if (out.length > 32768) child.kill();
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.passed === false && /^[a-z-]{1,60}$/.test(value.stage))
            console.error(`Closed-stack check failed at ${value.stage}`);
        } catch {}
      }
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error("CLOSED_OPERATOR_COMMAND_FAILED")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
try {
  if (!process.argv[2]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of [
      "db-owner-password",
      "db-api-password",
      "db-worker-password",
      "jwt-signing-key",
      "identity-key",
    ])
      await writeFile(
        join(directory, name),
        randomBytes(32).toString(
          name === "identity-key" ? "base64" : "base64url",
        ) + "\n",
        { mode: 0o600, flag: "wx" },
      );
  }
  stage = "empty-db";
  await docker([...compose, "up", "-d", "--wait", "db"]);
  stage = "runtime-roles";
  await docker([
    ...compose,
    "exec",
    "-T",
    "db",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "nuvomailo_owner",
    "-d",
    "nuvomailo",
    "-f",
    "/docker-entrypoint-initdb.d/010-roles.sql",
  ]);
  stage = "native-runtime-passwords";
  for (const [role, file] of [
    ["nuvomailo_api", "db-api-password"],
    ["nuvomailo_worker", "db-worker-password"],
  ]) {
    const password = (await readFile(join(directory, file), "utf8")).trim();
    await docker(
      [
        ...compose,
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "nuvomailo_owner",
        "-d",
        "nuvomailo",
        "-c",
        `\\password ${role}`,
      ],
      password + "\n" + password + "\n",
    );
    await docker([
      ...compose,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "nuvomailo_owner",
      "-d",
      "nuvomailo",
      "-c",
      `ALTER ROLE ${role} LOGIN`,
    ]);
  }
  stage = "migration";
  await docker([...compose, "run", "--rm", "-T", "migrate"]);
  stage = "closed-runtime";
  await docker([
    ...compose,
    "up",
    "-d",
    "--no-build",
    "--wait",
    "api",
    "worker",
  ]);
  stage = "http-conformance";
  const output = await docker([...compose, "run", "--rm", "-T", "probe"]);
  const report = output
    .split("\n")
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .find((value) => value?.passed === true);
  if (!report) throw new Error("MISSING_REPORT");
  stage = "restart-persistence";
  const inventory = () =>
    docker([
      ...compose,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "nuvomailo_owner",
      "-d",
      "nuvomailo",
      "-At",
      "-c",
      "SELECT (SELECT count(*) FROM users)||':'||(SELECT count(*) FROM organizations)||':'||(SELECT count(*) FROM identity_sessions)||':'||(SELECT count(*) FROM users WHERE mfa_secret_enc IS NOT NULL)",
    ]);
  const before = (await inventory()).trim();
  if (!/^[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$/.test(before))
    throw new Error("MISSING_PERSISTED_FIXTURES");
  // Stop in dependency order; avoid API/worker startup racing PostgreSQL recovery.
  await docker([...compose, "stop", "api", "worker", "db"]);
  await docker([
    ...compose,
    "up",
    "-d",
    "--no-build",
    "--wait",
    "api",
    "worker",
  ]);
  if ((await inventory()).trim() !== before)
    throw new Error("RESTART_DATA_CHANGED");
  const afterRestart = await docker([...compose, "run", "--rm", "-T", "probe"]);
  if (
    !afterRestart.split("\n").some((line) => {
      try {
        return JSON.parse(line).passed === true;
      } catch {
        return false;
      }
    })
  )
    throw new Error("RESTART_HTTP_FAILED");
  const worker = await docker([...compose, "ps", "-q", "worker"]);
  const config = JSON.parse(
    await docker(["inspect", worker.trim(), "--format", "{{json .Mounts}}"]),
  );
  if (
    config.some((mount) =>
      /jwt|identity|docker.sock|credential/i.test(mount.Destination),
    )
  )
    throw new Error("WORKER_SECRET_BOUNDARY_FAILED");
  console.log(
    JSON.stringify({
      ...report,
      workerHasNoSigningIdentityOrMailSecrets: true,
      databaseIdentityMfaAndSessionInventoryPreservedOnRestart: true,
      httpConformancePassedAfterRestart: true,
      syntheticProject: project,
      secretsAndVolumesRetained: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "CLOSED_REHEARSAL_FAILED",
      syntheticProject: project,
      secretsAndVolumesRetained: true,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await docker([...compose, "stop", "api", "worker", "db"]);
  } catch {
    process.exitCode = 1;
  }
}
