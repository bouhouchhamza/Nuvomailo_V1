import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { z } from "zod";
import pool from "../config/database.js";
import { tenantWrite } from "./tenant-context.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { transaction } from "../repositories/transaction.js";
import { HttpError } from "../middlewares/errors.js";
import type {
  MailCredentials,
  WebmailProvider,
} from "../adapters/webmail.adapter.js";
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const folder = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.split("/").every((part) => part !== "." && part !== ".."),
    "Invalid folder",
  );
const selection = z
  .object({
    folder,
    uid: z.coerce.number().int().min(1).max(4294967295),
    validity: z.string().regex(/^\d{1,20}$/),
  })
  .strict();
const recipient = z.string().trim().toLowerCase().email().max(254);
const contact = z
  .object({
    displayName: z.string().trim().max(100).default(""),
    email: recipient,
  })
  .strict();
const compose = z
  .object({
    to: z.array(recipient).max(20).default([]),
    cc: z.array(recipient).max(20).default([]),
    bcc: z.array(recipient).max(20).default([]),
    subject: z
      .string()
      .max(998)
      .refine((v) => !/[\r\n]/.test(v)),
    text: z.string().max(1000000),
    html: z.string().max(1000000).optional(),
    inReplyTo: z
      .string()
      .max(998)
      .refine((v) => !/[\r\n]/.test(v))
      .optional(),
    references: z
      .array(
        z
          .string()
          .max(998)
          .refine((v) => !/[\r\n]/.test(v)),
      )
      .max(50)
      .optional(),
    attachments: z
      .array(
        z
          .object({
            filename: z
              .string()
              .min(1)
              .max(100)
              .refine((v) => !/[\r\n\x00/\\]/.test(v)),
            contentBase64: z
              .string()
              .max(1400000)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
              )
              .refine(
                (value) => Buffer.byteLength(value, "base64") <= 1024 * 1024,
                "Attachment exceeds 1 MiB",
              ),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    idempotencyKey: z.uuid().optional(),
  })
  .strict();
interface Entry {
  actor: string;
  dashboardSession: string;
  mailboxId: string;
  address: string;
  expires: number;
  sealed: Buffer;
  nonce: Buffer;
  tag: Buffer;
}
export class WebmailService {
  private key = randomBytes(32);
  private sessions = new Map<string, Entry>();
  constructor(private provider?: WebmailProvider) {}
  private configured() {
    if (!this.provider)
      throw new HttpError(503, "Webmail provider is not configured");
    return this.provider;
  }
  async available(actor: string) {
    return {
      mode: this.provider?.mode ?? "unconfigured",
      mailboxes: (
        await pool.query(
          `SELECT m.id,m.local_part||'@'||d.name AS address,a.permission FROM mailbox_access a JOIN mailboxes m ON m.id=a.mailbox_id JOIN domains d ON d.id=m.domain_id JOIN memberships membership ON membership.organization_id=d.organization_id AND membership.user_id=a.user_id JOIN organizations o ON o.id=d.organization_id WHERE a.user_id=$1 AND o.status='active' AND d.status='active' ORDER BY m.id LIMIT 100`,
          [actor],
        )
      ).rows,
    };
  }
  private async authorize(actor: string, mailboxId: string, write = false) {
    const row = (
      await pool.query(
        `SELECT m.local_part||'@'||d.name AS address,a.permission FROM mailbox_access a JOIN mailboxes m ON m.id=a.mailbox_id JOIN domains d ON d.id=m.domain_id JOIN memberships membership ON membership.organization_id=d.organization_id AND membership.user_id=a.user_id JOIN organizations o ON o.id=d.organization_id JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND m.id=$2 AND u.status='active' AND o.status='active' AND d.status='active' AND d.verification_status='verified' AND d.mail_activation='local-lab' AND m.desired_status='active'`,
        [actor, mailboxId],
      )
    ).rows[0];
    if (!row || (write && row.permission !== "write"))
      throw new HttpError(404, "Mailbox access not available");
    return row.address as string;
  }
  async connect(
    actor: string,
    dashboardSession: string | undefined,
    input: unknown,
  ) {
    const provider = this.configured();
    if (!dashboardSession)
      throw new HttpError(401, "A persistent dashboard session is required");
    const { mailboxId, password } = z
      .object({ mailboxId: z.uuid(), password: z.string().min(1).max(128) })
      .strict()
      .parse(input);
    const address = await this.authorize(actor, mailboxId);
    for (const [id, entry] of this.sessions)
      if (entry.expires <= Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 100)
      throw new HttpError(503, "Mail session limit reached");
    await provider.authenticate({ address, password });
    await this.authorize(actor, mailboxId); // Access may be revoked during protocol authentication.
    if (this.sessions.size >= 100)
      throw new HttpError(503, "Mail session limit reached");
    const token = randomBytes(48).toString("base64url"),
      nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(
      Buffer.from(actor + ":" + dashboardSession + ":" + mailboxId),
    );
    const sealed = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    this.sessions.set(fingerprint(token), {
      actor,
      dashboardSession,
      mailboxId,
      address,
      expires: Date.now() + 15 * 60000,
      sealed,
      nonce,
      tag: cipher.getAuthTag(),
    });
    return { token, mailboxId, expiresIn: 900 };
  }
  private async credentials(
    actor: string,
    dashboardSession: string | undefined,
    token: string | undefined,
    write = false,
  ): Promise<MailCredentials> {
    const entry = await this.sessionEntry(
      actor,
      dashboardSession,
      token,
      write,
    );
    const decipher = createDecipheriv("aes-256-gcm", this.key, entry.nonce);
    decipher.setAAD(
      Buffer.from(actor + ":" + dashboardSession + ":" + entry.mailboxId),
    );
    decipher.setAuthTag(entry.tag);
    return {
      address: entry.address,
      password: Buffer.concat([
        decipher.update(entry.sealed),
        decipher.final(),
      ]).toString("utf8"),
    };
  }
  private async sessionEntry(
    actor: string,
    dashboardSession: string | undefined,
    token: string | undefined,
    write = false,
  ) {
    this.configured();
    const entry = token ? this.sessions.get(fingerprint(token)) : undefined;
    if (
      !entry ||
      entry.actor !== actor ||
      entry.dashboardSession !== dashboardSession ||
      entry.expires <= Date.now()
    )
      throw new HttpError(
        409,
        "Mail session expired or unavailable; connect again",
      );
    const address = await this.authorize(actor, entry.mailboxId, write);
    if (address !== entry.address)
      throw new HttpError(409, "Mailbox identity changed; connect again");
    return entry;
  }
  disconnect(
    actor: string,
    dashboardSession: string | undefined,
    token?: string,
  ) {
    const entry = token ? this.sessions.get(fingerprint(token)) : undefined;
    if (
      token &&
      entry?.actor === actor &&
      entry.dashboardSession === dashboardSession
    )
      this.sessions.delete(fingerprint(token));
  }
  async folders(actor: string, sid: string | undefined, token?: string) {
    return this.configured().folders(await this.credentials(actor, sid, token));
  }
  async createFolder(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
  ) {
    const value = z.object({ folder }).strict().parse(input);
    await this.configured().createFolder(
      await this.credentials(actor, sid, token, true),
      value.folder,
    );
  }
  async list(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
  ) {
    const data = z
      .object({
        folder: folder.default("INBOX"),
        before: z.coerce.number().int().min(1).max(4294967295).optional(),
        query: z.string().max(200).default(""),
      })
      .strict()
      .parse(input);
    return this.configured().list(
      await this.credentials(actor, sid, token),
      data.folder,
      data.before,
      data.query,
    );
  }
  async message(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
  ) {
    const data = selection.parse(input);
    return this.configured().message(
      await this.credentials(actor, sid, token),
      data.folder,
      data.uid,
      data.validity,
    );
  }
  async attachment(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
  ) {
    const data = selection
      .extend({ index: z.coerce.number().int().min(0).max(99) })
      .parse(input);
    return this.configured().attachment(
      await this.credentials(actor, sid, token),
      data.folder,
      data.uid,
      data.validity,
      data.index,
    );
  }
  async change(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
  ) {
    const data = selection
      .extend({ action: z.enum(["read", "unread", "trash"]) })
      .parse(input);
    await this.configured().change(
      await this.credentials(actor, sid, token, true),
      data.folder,
      data.uid,
      data.validity,
      data.action,
    );
  }
  async contacts(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
  ) {
    const entry = await this.sessionEntry(actor, sid, token);
    return (
      await pool.query(
        `SELECT id,display_name AS "displayName",email FROM webmail_contacts
        WHERE mailbox_id=$1 AND user_id=$2 ORDER BY lower(display_name),email,id LIMIT 500`,
        [entry.mailboxId, actor],
      )
    ).rows;
  }
  async saveContact(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
  ) {
    const entry = await this.sessionEntry(actor, sid, token);
    const data = contact.parse(input);
    return (
      await pool.query(
        `INSERT INTO webmail_contacts(mailbox_id,user_id,display_name,email)
        VALUES($1,$2,$3,$4) ON CONFLICT(mailbox_id,user_id,email)
        DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=NOW()
        RETURNING id,display_name AS "displayName",email`,
        [entry.mailboxId, actor, data.displayName, data.email],
      )
    ).rows[0];
  }
  async deleteContact(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    id: string,
  ) {
    z.uuid().parse(id);
    const entry = await this.sessionEntry(actor, sid, token);
    const removed = await pool.query(
      "DELETE FROM webmail_contacts WHERE id=$1 AND mailbox_id=$2 AND user_id=$3 RETURNING id",
      [id, entry.mailboxId, actor],
    );
    if (!removed.rowCount) throw new HttpError(404, "Contact not found");
  }
  async sendAttempts(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
  ) {
    const entry = await this.sessionEntry(actor, sid, token);
    return (
      await pool.query(
        `SELECT id,state,resolution,resolved_at AS "resolvedAt",
        sent_copy_stored AS "sentCopyStored",
        accepted_recipient_count AS "acceptedRecipientCount",
        rejected_recipient_count AS "rejectedRecipientCount",
        created_at AS "createdAt",finished_at AS "finishedAt"
        FROM webmail_send_attempts WHERE mailbox_id=$1 AND user_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 50`,
        [entry.mailboxId, actor],
      )
    ).rows;
  }
  async resolveSendAttempt(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    id: string,
    input: unknown,
  ) {
    z.uuid().parse(id);
    const entry = await this.sessionEntry(actor, sid, token, true);
    const { resolution } = z
      .object({
        resolution: z.enum(["confirmed_sent", "confirmed_not_sent"]),
      })
      .strict()
      .parse(input);
    return transaction(async (db) => {
      const updated = await db.query(
        `UPDATE webmail_send_attempts SET resolution=$4,resolved_at=NOW()
        WHERE id=$1 AND mailbox_id=$2 AND user_id=$3 AND state='uncertain'
        AND resolution IS NULL RETURNING id,resolution,resolved_at AS "resolvedAt"`,
        [id, entry.mailboxId, actor, resolution],
      );
      if (!updated.rowCount) {
        const existing = (
          await db.query(
            `SELECT state,resolution,resolved_at AS "resolvedAt"
            FROM webmail_send_attempts WHERE id=$1 AND mailbox_id=$2 AND user_id=$3`,
            [id, entry.mailboxId, actor],
          )
        ).rows[0];
        if (!existing) throw new HttpError(404, "Send attempt not found");
        if (existing.resolution === resolution)
          return { id, resolution, resolvedAt: existing.resolvedAt };
        if (existing.resolution)
          throw new HttpError(409, "Send attempt already resolved");
        throw new HttpError(409, "Only uncertain sends can be resolved");
      }
      const organizationId = (
        await db.query(
          `SELECT d.organization_id FROM mailboxes m JOIN domains d ON d.id=m.domain_id
          WHERE m.id=$1`,
          [entry.mailboxId],
        )
      ).rows[0]?.organization_id;
      if (!organizationId) throw new HttpError(404, "Mailbox not found");
      await appendAudit(db, {
        organizationId,
        actorId: actor,
        action: "webmail.send_attempt.resolved",
        resourceId: id,
        metadata: { resolution },
      });
      return updated.rows[0];
    });
  }
  async compose(
    actor: string,
    sid: string | undefined,
    token: string | undefined,
    input: unknown,
    draft = false,
  ) {
    const data = compose.parse(input);
    if (!draft && !data.to.length && !data.cc.length && !data.bcc.length)
      throw new HttpError(400, "At least one recipient is required");
    const { idempotencyKey, ...message } = data;
    const credentials = await this.credentials(actor, sid, token, true);
    if (draft) return this.configured().compose(credentials, message, true);
    if (!idempotencyKey)
      throw new HttpError(400, "A send idempotency key is required");
    const entry = await this.sessionEntry(actor, sid, token, true),
      requestDigest = fingerprint(JSON.stringify(message));
    const inserted = await pool.query(
      `INSERT INTO webmail_send_attempts(mailbox_id,user_id,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4) ON CONFLICT(mailbox_id,user_id,idempotency_key) DO NOTHING RETURNING id`,
      [entry.mailboxId, actor, idempotencyKey, requestDigest],
    );
    if (!inserted.rowCount) {
      const previous = (
        await pool.query(
          `SELECT state,request_digest,sent_copy_stored,accepted_recipient_count,rejected_recipient_count,
          created_at FROM webmail_send_attempts WHERE mailbox_id=$1 AND user_id=$2 AND idempotency_key=$3`,
          [entry.mailboxId, actor, idempotencyKey],
        )
      ).rows[0];
      if (!previous || previous.request_digest !== requestDigest)
        throw new HttpError(409, "Send key does not match this message");
      if (previous.state === "accepted")
        return {
          smtpAccepted: true,
          sentCopyStored: previous.sent_copy_stored === true,
          draftSaved: false,
          acceptedRecipients: [],
          rejectedRecipients: [],
          acceptedRecipientCount: previous.accepted_recipient_count ?? 0,
          rejectedRecipientCount: previous.rejected_recipient_count ?? 0,
          replayed: true,
        };
      if (
        previous.state === "processing" &&
        Date.now() - new Date(previous.created_at).getTime() < 120_000
      )
        throw new HttpError(409, "This send is already in progress");
      await pool.query(
        `UPDATE webmail_send_attempts SET state='uncertain',finished_at=COALESCE(finished_at,NOW())
        WHERE mailbox_id=$1 AND user_id=$2 AND idempotency_key=$3 AND state='processing'`,
        [entry.mailboxId, actor, idempotencyKey],
      );
      throw new HttpError(
        409,
        "Send outcome is uncertain; inspect Sent before composing a new message",
      );
    }
    try {
      const result = await this.configured().compose(
        credentials,
        message,
        false,
      );
      if (!result.smtpAccepted)
        throw new Error("Provider returned without SMTP acceptance");
      const accepted = result.acceptedRecipients?.length ?? 0,
        rejected = result.rejectedRecipients?.length ?? 0;
      const acknowledged = await pool.query(
        `UPDATE webmail_send_attempts SET state='accepted',sent_copy_stored=$2,
        accepted_recipient_count=$3,rejected_recipient_count=$4,finished_at=NOW()
        WHERE id=$1 AND state='processing' RETURNING id`,
        [inserted.rows[0].id, result.sentCopyStored, accepted, rejected],
      );
      if (!acknowledged.rowCount)
        throw new Error("Send acknowledgement was fenced");
      return result;
    } catch {
      await pool.query(
        `UPDATE webmail_send_attempts SET state='uncertain',finished_at=NOW()
        WHERE id=$1 AND state='processing'`,
        [inserted.rows[0].id],
      );
      throw new HttpError(
        503,
        "Send outcome is uncertain; inspect Sent before composing a new message",
      );
    }
  }
}
export async function assignMailbox(
  actor: string,
  org: string,
  mailboxId: string,
  input: unknown,
) {
  z.uuid().parse(mailboxId);
  const { userId, permission } = z
    .object({
      userId: z.uuid(),
      permission: z.enum(["read", "write", "revoke"]),
    })
    .strict()
    .parse(input);
  await tenantWrite(actor, org, "owner", async (db) => {
    if (
      !(
        await db.query(
          "SELECT 1 FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 AND d.organization_id=$2",
          [mailboxId, org],
        )
      ).rowCount
    )
      throw new HttpError(404, "Mailbox not found");
    if (permission === "revoke")
      await db.query(
        "DELETE FROM mailbox_access WHERE mailbox_id=$1 AND user_id=$2",
        [mailboxId, userId],
      );
    else {
      if (
        !(
          await db.query(
            "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.organization_id=$2 AND u.status='active' AND u.email_verified_at IS NOT NULL",
            [userId, org],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "An active verified organization member is required",
        );
      await db.query(
        "INSERT INTO mailbox_access(mailbox_id,user_id,permission) VALUES($1,$2,$3) ON CONFLICT(mailbox_id,user_id) DO UPDATE SET permission=EXCLUDED.permission",
        [mailboxId, userId, permission],
      );
    }
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "mailbox.access_changed",
      resourceId: mailboxId,
      metadata: { userId, permission },
    });
  });
}
