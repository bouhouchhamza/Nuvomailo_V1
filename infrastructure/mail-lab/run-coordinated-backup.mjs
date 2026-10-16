import { spawn } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  id = randomUUID(),
  project = `nuvomailo-coordinated-${id.slice(0, 8)}`,
  source = ["compose", "-f", "infrastructure/mail-lab/compose.yaml"],
  restore = [
    "compose",
    "-p",
    project,
    "-f",
    "infrastructure/mail-lab/coordinated-backup.compose.yaml",
  ];
let stage = "quiesce";
const fixture = {
  actor: randomUUID(),
  sid: randomUUID(),
  token: randomBytes(48).toString("base64url"),
  sendAttempt: randomUUID(),
  sendKey: randomUUID(),
};
let createdFixture = false;
function docker(args, input, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        try {
          const result = JSON.parse(line);
          if (
            typeof result.error === "string" &&
            /^[A-Z_]{1,60}$/.test(result.error)
          )
            console.error(JSON.stringify({ helperError: result.error }));
        } catch {}
      }
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && size <= limit
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("OPERATOR_COMMAND_FAILED")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
try {
  await docker(["volume", "create", "nuvomailo-dms-lab_coordinated-archives"]);
  await docker(["volume", "create", "nuvomailo-dms-lab_backup-keys"]);
  const running = (
    await docker([
      "ps",
      "--filter",
      "label=com.docker.compose.project=nuvomailo-dms-lab",
      "--format",
      '{{.Label "com.docker.compose.service"}}',
    ])
  )
    .toString()
    .trim()
    .split("\n");
  if (
    running.some(
      (service) =>
        service &&
        !["mail", "db", "credential-broker", "init"].includes(service),
    )
  )
    throw new Error("QUIESCE_WORKERS_FIRST");
  await docker([...source, "stop", "mail", "credential-broker"]);
  await docker([...source, "up", "-d", "db"]);
  stage = "consumed-grant-fixture";
  const grantDigest = createHash("sha256").update(fixture.token).digest("hex");
  await docker([
    ...source,
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "lab",
    "-d",
    "nuvomailo_lab",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `BEGIN; INSERT INTO users(id,email,password_hash,email_verified_at) VALUES('${fixture.actor}','${fixture.actor}@lab.invalid','synthetic-no-dashboard-login',NOW()); INSERT INTO memberships(user_id,organization_id,role) VALUES('${fixture.actor}','11111111-1111-4111-8111-111111111111','member'); INSERT INTO identity_sessions(id,user_id,expires_at) VALUES('${fixture.sid}','${fixture.actor}',NOW()+INTERVAL '1 hour'); INSERT INTO mailbox_access(mailbox_id,user_id,permission) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${fixture.actor}','write'); INSERT INTO mailbox_credential_grants(digest,mailbox_id,user_id,session_id,purpose,expires_at,consumed_at) VALUES('${grantDigest}','cccccccc-cccc-4ccc-8ccc-cccccccccccc','${fixture.actor}','${fixture.sid}','reset',NOW()+INTERVAL '15 minutes',NOW()); COMMIT;`,
  ]);
  createdFixture = true;
  stage = "resolved-send-fixture";
  await docker([...source,"exec","-T","db","psql","-U","lab","-d","nuvomailo_lab",
    "-v","ON_ERROR_STOP=1","-c",
    `INSERT INTO webmail_send_attempts(id,mailbox_id,user_id,idempotency_key,request_digest,state,finished_at,resolution,resolved_at)
    VALUES('${fixture.sendAttempt}','cccccccc-cccc-4ccc-8ccc-cccccccccccc','${fixture.actor}',
    '${fixture.sendKey}','${createHash("sha256").update("synthetic-recovery-send").digest("hex")}',
    'uncertain',NOW(),'confirmed_not_sent',NOW());`,
  ]);
  stage = "database-snapshot";
  const dump = await docker(
    [
      ...source,
      "exec",
      "-T",
      "db",
      "pg_dump",
      "-U",
      "lab",
      "-d",
      "nuvomailo_lab",
      "-Fc",
    ],
    undefined,
    8 * 1024 * 1024,
  );
  if (dump.subarray(0, 5).toString() !== "PGDMP")
    throw new Error("INVALID_DUMP");
  stage = "encrypted-snapshot";
  const backup = JSON.parse(
    (
      await docker(
        [...restore, "run", "--rm", "-T", "helper", "backup", id],
        dump,
      )
    ).toString(),
  );
  console.log(JSON.stringify(backup));
  stage = "tamper-rejection";
  console.log(
    (await docker([...restore, "run", "--rm", "-T", "helper", "tamper", id]))
      .toString()
      .trim(),
  );
  stage = "empty-volume-restore";
  console.log(
    (await docker([...restore, "run", "--rm", "-T", "helper", "restore", id]))
      .toString()
      .trim(),
  );
  stage = "database-restore";
  await docker([...restore, "up", "-d", "--wait", "db"]);
  const empty = (
    await docker([
      ...restore,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "lab",
      "-d",
      "nuvomailo_lab",
      "-Atc",
      "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
    ])
  )
    .toString()
    .trim();
  if (empty !== "0") throw new Error("RESTORE_DATABASE_NOT_EMPTY");
  const restoredDump = await docker(
    [...restore, "run", "--rm", "-T", "helper", "database", id],
    undefined,
    8 * 1024 * 1024,
  );
  await docker(
    [
      ...restore,
      "exec",
      "-T",
      "db",
      "pg_restore",
      "-U",
      "lab",
      "-d",
      "nuvomailo_lab",
      "--no-owner",
      "--exit-on-error",
    ],
    restoredDump,
  );
  stage = "database-evidence";
  const counts = (
    await docker([
      ...restore,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "lab",
      "-d",
      "nuvomailo_lab",
      "-Atc",
      "SELECT json_build_object('mailboxes',(SELECT count(*) FROM mailboxes),'credentialArtifacts',(SELECT count(*) FROM mailbox_credential_artifacts),'routingRequests',(SELECT count(*) FROM mail_routing_requests),'consumedGrants',(SELECT count(*) FROM mailbox_credential_grants WHERE consumed_at IS NOT NULL))",
    ])
  )
    .toString()
    .trim();
  stage = "restored-key-generation-replay";
  console.log(
    (
      await docker(
        [...restore, "run", "--rm", "-T", "verify"],
        Buffer.from(JSON.stringify(fixture)),
      )
    )
      .toString()
      .trim(),
  );
  console.log(
    JSON.stringify({
      passed: true,
      snapshotId: id,
      restoreProject: project,
      coordinatedDatabaseMailAndKeys: true,
      databaseCounts: JSON.parse(counts),
      productionRecoveryVerified: false,
      volumesPreserved: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "COORDINATED_RECOVERY_FAILED",
      restoreProject: project,
      snapshotId: id,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    if (createdFixture)
      await docker([
        ...source,
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "lab",
        "-d",
        "nuvomailo_lab",
        "-c",
        `DELETE FROM users WHERE id='${fixture.actor}'`,
      ]);
    await docker([...restore, "stop", "db"]);
    await docker([...source, "stop", "db"]);
  } catch {
    process.exitCode = 1;
  }
}
