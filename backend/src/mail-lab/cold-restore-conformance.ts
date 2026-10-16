import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createDecipheriv, createHash } from "node:crypto";
import pool from "../config/database.js";
import { LocalImapSmtpProvider } from "../adapters/webmail.adapter.js";
import { rpc } from "./rpc.js";
let stage = "input";
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2048) throw new Error("INPUT_LIMIT");
  }
  const credentials = JSON.parse(input) as {
    address: string;
    password: string;
  };
  assert.equal(credentials.address, "pilot@tenant-a.lab.invalid");
  const provider = new LocalImapSmtpProvider(
    await readFile("/run/nuvomailo-public-trust/lab-cert.pem"),
  );
  stage = "restored-imap";
  await provider.authenticate(credentials);
  const existing = (await provider.list(
    credentials,
    "INBOX",
    undefined,
    "",
  )) as { items: unknown[] };
  assert.ok(existing.items.length > 0);
  stage = "restored-submission";
  const marker = `cold-recovery-${randomUUID()}`;
  await provider.compose(
    credentials,
    {
      to: [credentials.address],
      cc: [],
      bcc: [],
      subject: marker,
      text: "Synthetic delivery after coordinated cold restore",
      attachments: [],
    },
    false,
  );
  let received = false;
  for (let i = 0; i < 10; i++) {
    const listing = (await provider.list(
      credentials,
      "INBOX",
      undefined,
      marker,
    )) as { items: unknown[] };
    if (listing.items.length) {
      received = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(received);
  stage = "restored-credential-fence";
  const artifact = (
    await pool.query(
      "SELECT a.*,m.local_part||'@'||d.name AS address,d.organization_id FROM mailbox_credential_artifacts a JOIN mailboxes m ON m.id=a.mailbox_id JOIN domains d ON d.id=m.domain_id WHERE a.generation=m.credential_generation ORDER BY a.created_at DESC LIMIT 1",
    )
  ).rows[0];
  assert.ok(artifact);
  assert.ok(artifact.generation > 1);
  const key = Buffer.from(
      (await readFile("/run/nuvomailo-credential-vault/key", "utf8")).trim(),
      "hex",
    ),
    cipher = createDecipheriv("aes-256-gcm", key, artifact.nonce);
  cipher.setAAD(
    Buffer.from(`${artifact.mailbox_id}:${artifact.generation}:${artifact.id}`),
  );
  cipher.setAuthTag(artifact.tag);
  const hash = Buffer.concat([
    cipher.update(artifact.sealed),
    cipher.final(),
  ]).toString("utf8");
  const stale = await rpc("/v1/credential", {
    organizationId: artifact.organization_id,
    mailboxId: artifact.mailbox_id,
    address: artifact.address,
    generation: artifact.generation - 1,
    idempotencyKey: randomUUID(),
    hash,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "STALE_CREDENTIAL_GENERATION");
  const proof = JSON.parse(
    await readFile("/run/nuvomailo-public-trust/recovery-proof.json", "utf8"),
  );
  assert.equal(
    proof.credentials[artifact.mailbox_id].hashDigest,
    createHash("sha256").update(hash).digest("hex"),
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "cold-restored-verified-tls-imap",
        "stored-mail-present",
        "cold-restored-smtp-delivery",
        "restored-key-decrypts-artifact",
        "cold-restored-agent-rejects-stale-generation",
      ],
    }),
  );
} catch {
  console.error(
    JSON.stringify({ passed: false, stage, code: "COLD_RECOVERY_FAILED" }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
