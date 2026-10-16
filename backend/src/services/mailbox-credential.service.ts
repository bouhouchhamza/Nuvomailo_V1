import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import pool from "../config/database.js";
import { transaction, type Db } from "../repositories/transaction.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
import type { CredentialBroker } from "../adapters/credential-broker.adapter.js";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export interface CredentialDelivery {
  send(value: {
    userId: string;
    mailboxId: string;
    purpose: string;
    token: string;
    expiresAt: Date;
  }): Promise<void>;
}
export interface CredentialTarget {
  organizationId: string;
  mailboxId: string;
  address: string;
  generation: number;
  idempotencyKey: string;
  hash: string;
}
export interface CredentialApplier {
  apply(target: CredentialTarget): Promise<void>;
}
export class MailboxCredentialService {
  capabilities() {
    return {
      configured: !!this.broker && !!this.key,
      deliveryAvailable: !!this.delivery,
    };
  }
  async status(actor: string, sid: string | undefined, id: string) {
    this.configured();
    z.uuid().parse(id);
    return transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT mailbox_id,state,generation FROM mailbox_credential_requests WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Request unavailable");
      await this.authorize(db, actor, sid, row.mailbox_id);
      return { requestId: id, state: row.state, generation: row.generation };
    });
  }
  constructor(
    private broker?: CredentialBroker,
    private key?: Buffer,
    private delivery?: CredentialDelivery,
  ) {
    if (key && key.length !== 32)
      throw new Error("Credential encryption requires32 bytes");
  }
  private configured() {
    if (!this.broker || !this.key)
      throw new HttpError(503, "Mailbox credential provider is not configured");
    return { broker: this.broker, key: this.key };
  }
  private async authorize(
    db: Db,
    actor: string,
    sid: string | undefined,
    id: string,
  ) {
    const mapping = (
      await db.query(
        "SELECT d.organization_id FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=$1",
        [id],
      )
    ).rows[0];
    if (!mapping) throw new HttpError(404, "Mailbox unavailable");
    await db.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      mapping.organization_id,
    ]);
    const row = (
      await db.query(
        `SELECT m.credential_generation,m.local_part||'@'||d.name AS address,d.organization_id,u.password_hash,u.mfa_secret_enc,s.mfa_verified_at FROM mailboxes m JOIN domains d ON d.id=m.domain_id JOIN organizations o ON o.id=d.organization_id JOIN mailbox_access a ON a.mailbox_id=m.id JOIN users u ON u.id=a.user_id JOIN memberships member ON member.organization_id=o.id AND member.user_id=u.id JOIN identity_sessions s ON s.user_id=u.id WHERE m.id=$1 AND u.id=$2 AND s.id=$3 AND a.permission='write' AND u.status='active' AND u.email_verified_at IS NOT NULL AND o.status='active' AND d.status='active' AND d.verification_status='verified' AND d.mail_activation='local-lab' AND m.desired_status='active' AND s.revoked_at IS NULL AND s.expires_at>NOW() FOR UPDATE OF m`,
        [id, actor, sid ?? null],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Mailbox unavailable");
    if (!/^[a-z0-9._-]+@tenant-[ab]\.lab\.invalid$/.test(row.address))
      throw new HttpError(403, "Synthetic mailbox required");
    return row;
  }
  async issue(
    actor: string,
    sid: string | undefined,
    mailboxId: string,
    input: unknown,
  ) {
    this.configured();
    if (!this.delivery)
      throw new HttpError(503, "Mailbox setup delivery is not configured");
    z.uuid().parse(mailboxId);
    const value = z
      .object({
        purpose: z.enum(["setup", "reset", "rotate"]),
        dashboardPassword: z.string().min(1).max(128),
      })
      .strict()
      .parse(input);
    const token = randomBytes(48).toString("base64url"),
      expiresAt = new Date(Date.now() + 15 * 60000);
    await transaction(async (db) => {
      const row = await this.authorize(db, actor, sid, mailboxId);
      if (!(await argon2.verify(row.password_hash, value.dashboardPassword)))
        throw new HttpError(403, "Reauthentication required");
      if (
        row.mfa_secret_enc &&
        (!row.mfa_verified_at ||
          Date.now() - new Date(row.mfa_verified_at).getTime() > 15 * 60000)
      )
        throw new HttpError(403, "Recent MFA required");
      if (value.purpose === "setup" && row.credential_generation !== 0)
        throw new HttpError(409, "Use password reset or rotation");
      await db.query(
        "UPDATE mailbox_credential_grants SET revoked_at=NOW() WHERE mailbox_id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL",
        [mailboxId, actor],
      );
      await db.query(
        "INSERT INTO mailbox_credential_grants(digest,mailbox_id,user_id,session_id,purpose,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [digest(token), mailboxId, actor, sid, value.purpose, expiresAt],
      );
      await appendAudit(db, {
        organizationId: row.organization_id,
        actorId: actor,
        action: "mailbox.credential_grant_requested",
        resourceId: mailboxId,
        metadata: { purpose: value.purpose },
      });
    });
    try {
      await this.delivery.send({
        userId: actor,
        mailboxId,
        purpose: value.purpose,
        token,
        expiresAt,
      });
    } catch {
      await pool.query(
        "UPDATE mailbox_credential_grants SET revoked_at=NOW() WHERE digest=$1",
        [digest(token)],
      );
      throw new HttpError(503, "Setup delivery unavailable");
    }
    return { expiresAt };
  }
  async consume(actor: string, sid: string | undefined, input: unknown) {
    const { broker, key } = this.configured();
    const value = z
      .object({
        token: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
        purpose: z.enum(["setup", "reset", "rotate"]),
        password: z
          .string()
          .min(12)
          .max(128)
          .refine((v) => !/[\r\n\x00]/.test(v)),
      })
      .strict()
      .parse(input);
    const operation = await transaction(async (db) => {
      const lookup = (
        await db.query(
          "SELECT mailbox_id FROM mailbox_credential_grants WHERE digest=$1",
          [digest(value.token)],
        )
      ).rows[0];
      if (!lookup) throw new HttpError(400, "Invalid credential grant");
      const row = await this.authorize(db, actor, sid, lookup.mailbox_id);
      if (value.purpose === "setup" && row.credential_generation !== 0)
        throw new HttpError(409, "Use reset or rotation");
      const grant = (
        await db.query(
          "SELECT * FROM mailbox_credential_grants WHERE digest=$1 FOR UPDATE",
          [digest(value.token)],
        )
      ).rows[0];
      if (
        !grant ||
        grant.user_id !== actor ||
        grant.session_id !== sid ||
        grant.purpose !== value.purpose ||
        grant.consumed_at ||
        grant.revoked_at ||
        new Date(grant.expires_at).getTime() <= Date.now()
      )
        throw new HttpError(400, "Invalid credential grant");
      if (await argon2.verify(row.password_hash, value.password))
        throw new HttpError(400, "Mailbox and dashboard passwords must differ");
      const id = randomUUID(),
        generation = row.credential_generation + 1;
      await db.query(
        "UPDATE mailbox_credential_grants SET consumed_at=NOW() WHERE digest=$1",
        [grant.digest],
      );
      await db.query(
        "UPDATE mailboxes SET credential_generation=$2 WHERE id=$1",
        [grant.mailbox_id, generation],
      );
      await db.query(
        "INSERT INTO mailbox_credential_requests(id,mailbox_id,generation,state) VALUES($1,$2,$3,'hashing')",
        [id, grant.mailbox_id, generation],
      );
      await appendAudit(db, {
        organizationId: row.organization_id,
        actorId: actor,
        action: "mailbox.credential_requested",
        resourceId: grant.mailbox_id,
        metadata: { requestId: id, generation, purpose: value.purpose },
      });
      return { id, mailboxId: grant.mailbox_id as string, generation };
    });
    try {
      const hash = await broker.hash(value.password);
      if (
        !hash.startsWith("{ARGON2ID}$argon2id$") ||
        /[\r\n\x00|]/.test(hash) ||
        hash.length > 512
      )
        throw new Error("INVALID_PROVIDER_HASH");
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(
        Buffer.from(
          `${operation.mailboxId}:${operation.generation}:${operation.id}`,
        ),
      );
      const sealed = Buffer.concat([
        cipher.update(hash, "utf8"),
        cipher.final(),
      ]);
      await transaction(async (db) => {
        const row = (
          await db.query(
            "SELECT credential_generation FROM mailboxes WHERE id=$1 FOR UPDATE",
            [operation.mailboxId],
          )
        ).rows[0];
        if (row?.credential_generation !== operation.generation) {
          await db.query(
            "UPDATE mailbox_credential_requests SET state='superseded' WHERE id=$1",
            [operation.id],
          );
          return;
        }
        await db.query(
          "INSERT INTO mailbox_credential_artifacts(id,mailbox_id,generation,key_id,nonce,tag,sealed) VALUES($1,$2,$3,'lab-v1',$4,$5,$6)",
          [
            operation.id,
            operation.mailboxId,
            operation.generation,
            nonce,
            cipher.getAuthTag(),
            sealed,
          ],
        );
        await db.query(
          "UPDATE mailbox_credential_requests SET artifact_id=$1,state='pending' WHERE id=$1",
          [operation.id],
        );
      });
    } catch {
      await pool.query(
        "UPDATE mailbox_credential_requests SET state='failed' WHERE id=$1 AND state='hashing'",
        [operation.id],
      );
      throw new HttpError(
        503,
        "Credential preparation failed; request a new grant",
      );
    }
    return { requestId: operation.id, generation: operation.generation };
  }
}
export async function runCredentialOnce(
  key: Buffer,
  applier: CredentialApplier,
) {
  const job = await transaction(async (db) => {
    await db.query(
      "UPDATE mailbox_credential_requests SET state='failed' WHERE state='hashing' AND created_at<NOW()-INTERVAL '10 minutes'",
    );
    const row = (
      await db.query(
        `SELECT r.*,m.credential_generation,d.organization_id,m.local_part||'@'||d.name AS address FROM mailbox_credential_requests r JOIN mailboxes m ON m.id=r.mailbox_id JOIN domains d ON d.id=m.domain_id JOIN organizations o ON o.id=d.organization_id WHERE (r.state='pending' OR (r.state='processing' AND r.lease_expires_at<NOW())) AND r.available_at<=NOW() AND o.status='active' AND d.status='active' AND d.mail_activation='local-lab' ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
      )
    ).rows[0];
    if (!row) return null;
    if (row.generation !== row.credential_generation) {
      await db.query(
        "UPDATE mailbox_credential_requests SET state='superseded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [row.id],
      );
      return null;
    }
    const lease = randomUUID();
    await db.query(
      "UPDATE mailbox_credential_requests SET state='processing',lease_token=$2,lease_expires_at=NOW()+INTERVAL '60 seconds',attempts=attempts+1 WHERE id=$1",
      [row.id, lease],
    );
    return { ...row, lease };
  });
  if (!job) return "idle";
  try {
    const artifact = (
      await pool.query(
        "SELECT * FROM mailbox_credential_artifacts WHERE id=$1 AND mailbox_id=$2 AND generation=$3 AND key_id='lab-v1'",
        [job.artifact_id, job.mailbox_id, job.generation],
      )
    ).rows[0];
    if (!artifact) throw new Error("ARTIFACT_UNAVAILABLE");
    const decipher = createDecipheriv("aes-256-gcm", key, artifact.nonce);
    decipher.setAAD(
      Buffer.from(`${job.mailbox_id}:${job.generation}:${job.artifact_id}`),
    );
    decipher.setAuthTag(artifact.tag);
    const hash = Buffer.concat([
      decipher.update(artifact.sealed),
      decipher.final(),
    ]).toString("utf8");
    await applier.apply({
      organizationId: job.organization_id,
      mailboxId: job.mailbox_id,
      address: job.address,
      generation: job.generation,
      idempotencyKey: job.id,
      hash,
    });
    const acknowledged = await pool.query(
      "UPDATE mailbox_credential_requests r SET state=CASE WHEN m.credential_generation=r.generation THEN 'applied' ELSE 'superseded' END,lease_token=NULL,lease_expires_at=NULL FROM mailboxes m WHERE r.id=$1 AND r.lease_token=$2 AND m.id=r.mailbox_id RETURNING r.state",
      [job.id, job.lease],
    );
    return acknowledged.rows[0]?.state ?? "lease-lost";
  } catch {
    await pool.query(
      "UPDATE mailbox_credential_requests SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,available_at=NOW()+INTERVAL '30 seconds' WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease],
    );
    return "retry";
  }
}
