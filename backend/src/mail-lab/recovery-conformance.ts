import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDecipheriv, createHash } from "node:crypto";
import pool from "../config/database.js";
import { MailboxCredentialService } from "../services/mailbox-credential.service.js";
let stage = "fixture-input";
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2048) throw new Error("INPUT_LIMIT");
  }
  const fixture = JSON.parse(input) as {
    actor: string;
    sid: string;
    token: string;
    sendAttempt: string;
    sendKey: string;
  };
  stage = "restored-key";
  const key = Buffer.from(
    (await readFile("/run/nuvomailo-credential-vault/key", "utf8")).trim(),
    "hex",
  );
  const proof = JSON.parse(
    await readFile("/run/nuvomailo-public-trust/recovery-proof.json", "utf8"),
  ) as {
    credentials: Record<string, { generation: number; hashDigest: string }>;
    routing: Record<string, { target: { generation: number } }>;
  };
  stage = "artifact-query";
  const artifacts = (
    await pool.query(
      "SELECT a.* FROM mailbox_credential_artifacts a JOIN mailboxes m ON m.id=a.mailbox_id WHERE a.generation=m.credential_generation",
    )
  ).rows;
  assert.ok(artifacts.length > 0);
  for (const artifact of artifacts) {
    stage = "artifact-decryption";
    const cipher = createDecipheriv("aes-256-gcm", key, artifact.nonce);
    cipher.setAAD(
      Buffer.from(
        `${artifact.mailbox_id}:${artifact.generation}:${artifact.id}`,
      ),
    );
    cipher.setAuthTag(artifact.tag);
    const hash = Buffer.concat([
      cipher.update(artifact.sealed),
      cipher.final(),
    ]);
    stage = "credential-generation-match";
    assert.equal(
      proof.credentials[artifact.mailbox_id]?.generation,
      artifact.generation,
    );
    assert.equal(
      proof.credentials[artifact.mailbox_id]?.hashDigest,
      createHash("sha256").update(hash).digest("hex"),
    );
  }
  for (const [domain, value] of Object.entries(proof.routing)) {
    stage = "routing-generation-match";
    const row = (
      await pool.query("SELECT routing_generation FROM domains WHERE name=$1", [
        domain,
      ])
    ).rows[0];
    assert.equal(row?.routing_generation, value.target.generation);
  }
  stage = "consumed-grant-replay";
  const restoredGrant = (await pool.query(
    `SELECT consumed_at FROM mailbox_credential_grants
    WHERE digest=$1 AND user_id=$2 AND session_id=$3 AND purpose='reset'`,
    [createHash("sha256").update(fixture.token).digest("hex"),fixture.actor,fixture.sid],
  )).rows[0];
  assert.ok(restoredGrant?.consumed_at);
  let reachedHashing = false;
  const service = new MailboxCredentialService(
    {
      mode: "local-lab",
      hash: async () => {
        reachedHashing = true;
        throw new Error("REPLAY_REACHED_HASHING");
      },
    },
    key,
  );
  await assert.rejects(
    service.consume(fixture.actor, fixture.sid, {
      token: fixture.token,
      purpose: "reset",
      password: "SyntheticRestoreReplay123!",
    }),
    (error) =>
      error instanceof Error &&
      ["Invalid credential grant", "Mailbox unavailable"].includes(error.message),
  );
  assert.equal(reachedHashing, false);
  stage = "resolved-send-restoration";
  const restoredSend = (await pool.query(
    `SELECT state,resolution,resolved_at,request_digest FROM webmail_send_attempts
    WHERE id=$1 AND user_id=$2 AND idempotency_key=$3`,
    [fixture.sendAttempt,fixture.actor,fixture.sendKey],
  )).rows[0];
  assert.equal(restoredSend?.state,"uncertain");
  assert.equal(restoredSend?.resolution,"confirmed_not_sent");
  assert.ok(restoredSend?.resolved_at);
  assert.equal(restoredSend?.request_digest,
    createHash("sha256").update("synthetic-recovery-send").digest("hex"));
  console.log(
    JSON.stringify({
      passed: true,
      restoredCredentialArtifactsDecrypted: artifacts.length,
      remoteGenerationsMatchDatabase: true,
      consumedGrantReplayRejected: true,
      populatedSendResolutionRestored: true,
    }),
  );
} catch {
  console.error(JSON.stringify({passed:false,stage,code:"RESTORED_CREDENTIAL_STATE_INVALID"}));
  process.exitCode = 1;
} finally {
  await pool.end();
}
