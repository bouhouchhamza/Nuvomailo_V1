import { ImapFlow } from "imapflow";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { HttpError } from "../middlewares/errors.js";
import { env } from "../config/env.js";
export interface MailCredentials {
  address: string;
  password: string;
}
export interface ComposeMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; contentBase64: string }[];
}
export interface ComposeResult {
  smtpAccepted: boolean;
  sentCopyStored: boolean;
  draftSaved: boolean;
  acceptedRecipients?: string[];
  rejectedRecipients?: string[];
}
export interface WebmailProvider {
  readonly mode: "local-lab";
  authenticate(value: MailCredentials): Promise<void>;
  folders(value: MailCredentials): Promise<unknown>;
  createFolder(value: MailCredentials, path: string): Promise<void>;
  list(
    value: MailCredentials,
    folder: string,
    before: number | undefined,
    query: string,
  ): Promise<unknown>;
  message(
    value: MailCredentials,
    folder: string,
    uid: number,
    validity: string,
  ): Promise<unknown>;
  attachment(
    value: MailCredentials,
    folder: string,
    uid: number,
    validity: string,
    index: number,
  ): Promise<{ filename: string; content: Buffer }>;
  change(
    value: MailCredentials,
    folder: string,
    uid: number,
    validity: string,
    action: "read" | "unread" | "trash",
  ): Promise<void>;
  compose(
    value: MailCredentials,
    message: ComposeMessage,
    draft: boolean,
  ): Promise<ComposeResult>;
}
type ThreadSource = {
  uid: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
};
const messageIdPattern = /<[^<>\r\n]{1,998}>/g;
const normalizeMessageId = (value: string | undefined) => {
  const matched = value?.match(messageIdPattern)?.[0];
  return matched?.toLowerCase();
};
export function parseReferenceHeader(headers: Buffer | undefined) {
  if (!headers) return [];
  const value = headers.toString("utf8", 0, Math.min(headers.length, 65536));
  const match = value.match(/^references:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/im);
  return (
    (match?.[1] ?? "")
      .replace(/\r?\n[ \t]+/g, " ")
      .match(messageIdPattern)
      ?.map((item) => item.toLowerCase())
      .slice(-50) ?? []
  );
}
export function addThreadMetadata<T extends ThreadSource>(rows: T[]) {
  const derived = rows.map((row) => {
    const references = (row.references ?? [])
        .map((item) => normalizeMessageId(item))
        .filter((item): item is string => Boolean(item))
        .slice(-50),
      own = normalizeMessageId(row.messageId),
      parent = normalizeMessageId(row.inReplyTo),
      root = references[0] ?? parent ?? own ?? `uid:${row.uid}`,
      threadId = createHash("sha256").update(root).digest("hex").slice(0, 32);
    return {
      ...row,
      threadId,
      threadDepth: references.length || (parent ? 1 : 0),
    };
  });
  const sizes = new Map<string, number>();
  for (const row of derived)
    sizes.set(row.threadId, (sizes.get(row.threadId) ?? 0) + 1);
  return derived.map((row) => ({
    ...row,
    visibleThreadSize: sizes.get(row.threadId) ?? 1,
  }));
}
export function safeMailHtml(value: string) {
  return sanitizeHtml(value, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "blockquote",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "pre",
      "code",
      "span",
      "div",
    ],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "discard",
  });
}
export async function compileMail(
  address: string,
  message: ComposeMessage,
  draft = false,
) {
  const compiled = new MailComposer({
    from: address,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: safeMailHtml(message.html) } : {}),
    inReplyTo: message.inReplyTo,
    references: message.references,
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: message.attachments.map((item) => ({
      filename: item.filename,
      content: Buffer.from(item.contentBase64, "base64"),
    })),
  }).compile();
  // Hidden recipients are retained only inside the private Drafts folder.
  // SMTP/Sent compilation always strips this header, including drafts later sent.
  compiled.keepBcc = draft;
  return { message: await compiled.build(), messageId: compiled.messageId() };
}
/** Explicit synthetic-only provider. No URL/hostname/port can come from tenant input. */
export class LocalImapSmtpProvider implements WebmailProvider {
  readonly mode = "local-lab" as const;
  private active = 0;
  private composing = 0;
  constructor(private trust: Buffer) {
    if (env.NODE_ENV === "production")
      throw new Error("Synthetic webmail provider is local only");
  }
  private check(value: MailCredentials) {
    if (!/^[a-z0-9._-]+@tenant-[ab]\.lab\.invalid$/.test(value.address))
      throw new HttpError(403, "Synthetic mailbox required");
  }
  private async withClient<T>(
    value: MailCredentials,
    work: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    this.check(value);
    if (this.active >= 4) throw new HttpError(503, "Mail access is busy");
    this.active++;
    const client = new ImapFlow({
      host: "mail",
      port: 993,
      secure: true,
      auth: { user: value.address, pass: value.password },
      tls: {
        ca: this.trust,
        servername: "mail.lab.invalid",
        rejectUnauthorized: true,
      },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "Mail operation could not be confirmed");
    } finally {
      client.close();
      this.active--;
    }
  }
  async authenticate(value: MailCredentials) {
    await this.withClient(value, async () => {});
  }
  async folders(value: MailCredentials) {
    return this.withClient(value, async (client) =>
      (await client.list()).map((folder) => ({
        path: folder.path,
        name: folder.name,
        specialUse: folder.specialUse,
      })),
    );
  }
  async createFolder(value: MailCredentials, path: string) {
    await this.withClient(value, async (client) => {
      await client.mailboxCreate(path);
    });
  }
  private validity(client: ImapFlow, validity: string) {
    if (!client.mailbox || client.mailbox.uidValidity.toString() !== validity)
      throw new HttpError(409, "Mailbox changed; refresh the message list");
  }
  async list(
    value: MailCredentials,
    folder: string,
    before: number | undefined,
    query: string,
  ) {
    return this.withClient(value, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        if (!client.mailbox) throw new HttpError(503, "Mailbox unavailable");
        const upper =
          Math.min(before ?? client.mailbox.uidNext, client.mailbox.uidNext) -
          1;
        if (upper < 1)
          return {
            items: [],
            nextBeforeUid: null,
            uidValidity: client.mailbox.uidValidity.toString(),
          };
        const lower = Math.max(1, upper - 999);
        const ids = await client.search(
          { uid: `${lower}:${upper}`, ...(query ? { text: query } : {}) },
          { uid: true },
        );
        const selected = (Array.isArray(ids) ? ids : [])
          .sort((a, b) => b - a)
          .slice(0, 50);
        const rows = selected.length
          ? await client.fetchAll(
              selected,
              {
                uid: true,
                envelope: true,
                flags: true,
                size: true,
                headers: ["references"],
              },
              { uid: true },
            )
          : [];
        return {
          items: addThreadMetadata(
            rows
              .sort((a, b) => b.uid - a.uid)
              .map((row) => ({
                uid: row.uid,
                subject: row.envelope?.subject ?? "(no subject)",
                from: row.envelope?.from ?? [],
                to: row.envelope?.to ?? [],
                date: row.envelope?.date ?? null,
                messageId: row.envelope?.messageId,
                inReplyTo: row.envelope?.inReplyTo,
                references: parseReferenceHeader(row.headers),
                seen: row.flags?.has("\\Seen") ?? false,
                size: row.size,
              })),
          ),
          uidValidity: client.mailbox.uidValidity.toString(),
          nextBeforeUid:
            selected.length === 50 ? selected.at(-1) : lower > 1 ? lower : null,
        };
      } finally {
        lock.release();
      }
    });
  }
  private async parsed(
    client: ImapFlow,
    folder: string,
    uid: number,
    validity: string,
  ) {
    const lock = await client.getMailboxLock(folder);
    try {
      this.validity(client, validity);
      const info = await client.fetchOne(uid, { size: true }, { uid: true });
      if (!info) throw new HttpError(404, "Message not found");
      if ((info.size ?? Infinity) > 10 * 1024 * 1024)
        throw new HttpError(413, "Message exceeds webmail size limit");
      const source = await client.fetchOne(
        uid,
        { source: true },
        { uid: true },
      );
      if (!source || !source.source)
        throw new HttpError(404, "Message not found");
      return await simpleParser(source.source, {
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
      });
    } finally {
      lock.release();
    }
  }
  async message(
    value: MailCredentials,
    folder: string,
    uid: number,
    validity: string,
  ) {
    return this.withClient(value, async (client) => {
      const parsed = await this.parsed(client, folder, uid, validity);
      return {
        uid,
        subject: parsed.subject ?? "",
        from: parsed.from?.text ?? "",
        to: parsed.to,
        cc: parsed.cc,
        bcc: folder === "Drafts" ? parsed.bcc : undefined,
        text: parsed.text ?? "",
        html: parsed.html ? safeMailHtml(parsed.html) : null,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        date: parsed.date,
        attachments: parsed.attachments.map((attachment, index) => ({
          index,
          filename: attachment.filename ?? "attachment",
          size: attachment.size,
          contentType: attachment.contentType,
        })),
      };
    });
  }
  async attachment(
    value: MailCredentials,
    folder: string,
    uid: number,
    validity: string,
    index: number,
  ) {
    return this.withClient(value, async (client) => {
      const parsed = await this.parsed(client, folder, uid, validity);
      const attachment = parsed.attachments[index];
      if (!attachment) throw new HttpError(404, "Attachment not found");
      return {
        filename: (attachment.filename ?? "attachment")
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 100),
        content: attachment.content,
      };
    });
  }
  async change(
    value: MailCredentials,
    folder: string,
    uid: number,
    validity: string,
    action: "read" | "unread" | "trash",
  ) {
    await this.withClient(value, async (client) => {
      if (
        action === "trash" &&
        !(await client.list()).some((row) => row.path === "Trash")
      )
        await client.mailboxCreate("Trash");
      const lock = await client.getMailboxLock(folder);
      try {
        this.validity(client, validity);
        if (action === "trash") {
          if (folder === "Trash")
            throw new HttpError(409, "Permanent deletion is not enabled");
          await client.messageMove(uid, "Trash", { uid: true });
        } else if (action === "read")
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    });
  }
  async compose(
    value: MailCredentials,
    message: ComposeMessage,
    draft: boolean,
  ) {
    if (this.composing >= 4)
      throw new HttpError(503, "Mail composition is busy");
    this.composing++;
    try {
      return await this.composeBounded(value, message, draft);
    } finally {
      this.composing--;
    }
  }
  private async composeBounded(
    value: MailCredentials,
    message: ComposeMessage,
    draft: boolean,
  ) {
    this.check(value);
    for (const recipient of [...message.to, ...message.cc, ...message.bcc])
      if (!/^[a-z0-9._-]+@tenant-[ab]\.lab\.invalid$/.test(recipient))
        throw new HttpError(403, "External lab recipients are blocked");
    const built = await compileMail(value.address, message, draft);
    const raw = built.message as Buffer;
    if (raw.length > 5 * 1024 * 1024)
      throw new HttpError(413, "Message exceeds compose limit");
    let acceptedRecipients: string[] = [],
      rejectedRecipients: string[] = [];
    if (!draft) {
      const smtp = nodemailer.createTransport({
        host: "mail",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: value.address, pass: value.password },
        tls: {
          ca: this.trust,
          servername: "mail.lab.invalid",
          rejectUnauthorized: true,
        },
        logger: false,
        debug: false,
        disableFileAccess: true,
        disableUrlAccess: true,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        name: "webmail.lab.invalid",
      });
      try {
        const sent = await smtp.sendMail({
          envelope: {
            from: value.address,
            to: [...message.to, ...message.cc, ...message.bcc],
          },
          raw,
        });
        // Report partial acceptance without turning a successful DATA into a retryable failure.
        const intended = new Set([
          ...message.to,
          ...message.cc,
          ...message.bcc,
        ]);
        acceptedRecipients = sent.accepted.filter(
          (item): item is string =>
            typeof item === "string" && intended.has(item),
        );
        rejectedRecipients = sent.rejected.filter(
          (item): item is string =>
            typeof item === "string" && intended.has(item),
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          503,
          "Sending outcome is unconfirmed; check mail before retrying",
        );
      } finally {
        smtp.close();
      }
    }
    try {
      await this.withClient(value, async (client) => {
        const path = draft ? "Drafts" : "Sent";
        if (!(await client.list()).some((row) => row.path === path))
          await client.mailboxCreate(path);
        await client.append(path, raw, draft ? ["\\Draft"] : ["\\Seen"]);
      });
    } catch (error) {
      if (draft) throw error;
      return {
        smtpAccepted: true,
        sentCopyStored: false,
        draftSaved: false,
        messageId: built.messageId,
        acceptedRecipients,
        rejectedRecipients,
      };
    }
    return {
      smtpAccepted: !draft,
      sentCopyStored: !draft,
      draftSaved: draft,
      messageId: built.messageId,
      acceptedRecipients,
      rejectedRecipients,
    };
  }
}
