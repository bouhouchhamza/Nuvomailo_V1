import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
import type { Mailbox, Member } from "../types";
import { MailboxCredentials } from "./mailbox-credentials";
type Row = {
  uid: number;
  subject: string;
  seen: boolean;
  threadId?: string;
  threadDepth?: number;
  visibleThreadSize?: number;
};
type Contact = { id: string; displayName: string; email: string };
type SendAttempt = {
  id: string;
  state: "processing" | "accepted" | "uncertain";
  resolution: "confirmed_sent" | "confirmed_not_sent" | null;
  resolvedAt: string | null;
  sentCopyStored: boolean | null;
  acceptedRecipientCount: number | null;
  rejectedRecipientCount: number | null;
  createdAt: string;
  finishedAt: string | null;
};
type Listing = {
  items: Row[];
  uidValidity: string;
  nextBeforeUid: number | null;
};
type Message = {
  uid: number;
  subject: string;
  from: string;
  text: string;
  html: string | null;
  messageId?: string;
  to?: { value: { address?: string }[] } | { value: { address?: string }[] }[];
  cc?: { value: { address?: string }[] } | { value: { address?: string }[] }[];
  bcc?: { value: { address?: string }[] } | { value: { address?: string }[] }[];
  references?: string[] | string;
  inReplyTo?: string;
  attachments: { index: number; filename: string; size: number }[];
};
export function Webmail({
  orgId,
  mailboxes,
  members,
  isOwner,
}: {
  orgId: string;
  mailboxes: Mailbox[];
  members: Member[];
  isOwner: boolean;
}) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [available, setAvailable] = useState<
      { id: string; address: string; permission: string }[]
    >([]),
    [mode, setMode] = useState("unconfigured"),
    [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState(""),
    [password, setPassword] = useState(""),
    [connected, setConnected] = useState(false),
    [writable, setWritable] = useState(false);
  const [folders, setFolders] = useState<{ path: string }[]>([]),
    [folder, setFolder] = useState("INBOX"),
    [listing, setListing] = useState<Listing | null>(null),
    [query, setQuery] = useState(""),
    [message, setMessage] = useState<Message | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]),
    [contactName, setContactName] = useState(""),
    [contactEmail, setContactEmail] = useState(""),
    [sendAttempts, setSendAttempts] = useState<SendAttempt[]>([]);
  const [to, setTo] = useState(""),
    [cc, setCc] = useState(""),
    [bcc, setBcc] = useState(""),
    [subject, setSubject] = useState(""),
    [text, setText] = useState(""),
    [replyId, setReplyId] = useState<string | undefined>(),
    [references, setReferences] = useState<string[]>([]),
    [sendKey, setSendKey] = useState<string | undefined>(),
    [draftHtml, setDraftHtml] = useState<string | undefined>(),
    [files, setFiles] = useState<{ filename: string; contentBase64: string }[]>(
      [],
    ),
    [notice, setNotice] = useState("");
  const [assigned, setAssigned] = useState(""),
    [member, setMember] = useState(""),
    [permission, setPermission] = useState("read");
  async function load() {
    const data = await api<{ mode: string; mailboxes: typeof available }>(
      "/webmail",
    );
    setMode(data.mode);
    setAvailable(
      data.mailboxes.filter((row) =>
        mailboxes.some((box) => box.id === row.id),
      ),
    );
    setOpened(true);
  }
  async function refresh(path = folder, before?: number) {
    const params = new URLSearchParams({
      folder: path,
      query,
      ...(before ? { before: String(before) } : {}),
    });
    setListing(await api<Listing>(`/webmail/messages?${params}`));
    setMessage(null);
  }
  async function refreshSendAttempts() {
    const rows = await api<SendAttempt[]>("/webmail/send-attempts");
    setSendAttempts(Array.isArray(rows) ? rows : []);
  }
  async function resolveSendAttempt(
    id: string,
    resolution: "confirmed_sent" | "confirmed_not_sent",
  ) {
    await api(`/webmail/send-attempts/${id}/resolve`, "POST", { resolution });
    setSendKey(undefined);
    setNotice(
      resolution === "confirmed_sent"
        ? "Attempt marked as found in Sent. No message was submitted again."
        : "Attempt marked as not found in Sent. A future Send uses a new key.",
    );
    await refreshSendAttempts();
  }
  function connect(event: FormEvent) {
    event.preventDefault();
    const secret = password;
    setPassword("");
    void run(async () => {
      await api("/webmail/connect", "POST", {
        mailboxId: selected,
        password: secret,
      });
      setConnected(true);
      clearComposer();
      setWritable(
        available.find((row) => row.id === selected)?.permission === "write",
      );
      setFolders(await api<{ path: string }[]>("/webmail/folders"));
      const contactRows = await api<Contact[]>("/webmail/contacts");
      setContacts(Array.isArray(contactRows) ? contactRows : []);
      await refreshSendAttempts();
      setFolder("INBOX");
      await refresh("INBOX");
    });
  }
  function clearComposer() {
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setText("");
    setFiles([]);
    setReplyId(undefined);
    setReferences([]);
    setSendKey(undefined);
    setDraftHtml(undefined);
    setNotice("");
  }
  async function act(action: "read" | "unread" | "trash") {
    if (!message || !listing) return;
    await api("/webmail/message", "POST", {
      folder,
      uid: message.uid,
      validity: listing.uidValidity,
      action,
    });
    await refresh();
  }
  async function compose(draft: boolean) {
    const recipients = (value: string) =>
      value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    const idempotencyKey = draft
      ? undefined
      : (sendKey ?? globalThis.crypto.randomUUID());
    if (!draft && !sendKey) setSendKey(idempotencyKey);
    let result;
    try {
      result = await api<{
        smtpAccepted: boolean;
        sentCopyStored: boolean;
        draftSaved: boolean;
        rejectedRecipients?: string[];
        replayed?: boolean;
        acceptedRecipientCount?: number;
        rejectedRecipientCount?: number;
      }>(draft ? "/webmail/draft" : "/webmail/send", "POST", {
        to: recipients(to),
        cc: recipients(cc),
        bcc: recipients(bcc),
        subject,
        text,
        inReplyTo: replyId,
        references,
        html: draftHtml,
        attachments: files,
        idempotencyKey,
      });
    } catch (error) {
      if (!draft) await refreshSendAttempts();
      throw error;
    }
    const rejectedCount =
      result.rejectedRecipients?.length ?? result.rejectedRecipientCount ?? 0;
    setNotice(
      rejectedCount
        ? `SMTP accepted only some recipients. ${result.rejectedRecipients?.length ? `Rejected: ${result.rejectedRecipients.join(", ")}. ` : `${rejectedCount} recipient(s) were rejected. `}Do not resend to accepted recipients.${result.sentCopyStored ? " Sent copy saved." : " Sent copy could not be saved."}`
        : result.draftSaved
          ? "Draft saved."
          : result.sentCopyStored
            ? "SMTP accepted the message and saved a Sent copy."
            : "SMTP accepted the message, but the Sent copy failed. Check before sending again.",
    );
    if (!draft) {
      setSendKey(undefined);
      setText("");
      setFiles([]);
      setReplyId(undefined);
      setReferences([]);
      setDraftHtml(undefined);
    }
    if (!draft) await refreshSendAttempts();
    setFolders(await api<{ path: string }[]>("/webmail/folders"));
  }
  async function loadDraft() {
    if (!message || !listing) return;
    if (
      message.attachments.length > 5 ||
      message.attachments.some((item) => item.size > 1024 * 1024)
    )
      throw new Error(
        "Draft attachments exceed composer limits; original is preserved",
      );
    const attachments = await Promise.all(
      message.attachments.map(async (item) => {
        const blob = await api<Blob>(
          `/webmail/attachment?${new URLSearchParams({ folder, uid: String(message.uid), validity: listing.uidValidity, index: String(item.index) })}`,
          "GET",
          undefined,
          "blob",
        );
        if (blob.size > 1024 * 1024)
          throw new Error("Attachment limit exceeded");
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Cannot read attachment"));
          reader.onload = () =>
            resolve(String(reader.result).split(",")[1] ?? "");
          reader.readAsDataURL(blob);
        });
        return { filename: item.filename, contentBase64 };
      }),
    );
    const addresses = (value: Message["to"]) =>
      (Array.isArray(value) ? value : value ? [value] : [])
        .flatMap((item) =>
          item.value.map((entry) => entry.address).filter(Boolean),
        )
        .join(", ");
    setTo(addresses(message.to));
    setCc(addresses(message.cc));
    setBcc(addresses(message.bcc));
    setSubject(message.subject);
    setText(message.text);
    setDraftHtml(message.html ?? undefined);
    setSendKey(undefined);
    setFiles(attachments);
    setReplyId(message.inReplyTo);
    setReferences(
      Array.isArray(message.references)
        ? message.references
        : message.references
          ? [message.references]
          : [],
    );
    setNotice(
      "Draft loaded. Saving creates a revised copy and preserves the original. Editing text switches to plain text.",
    );
  }
  return (
    <section className="card">
      <h2>Webmail</h2>
      <p>
        Mailbox access requires an explicit assignment and a separate mailbox
        password. Local lab mail stays inside synthetic domains.
      </p>
      <ErrorMessage message={error} />
      {notice && <p role="status">{notice}</p>}
      <button disabled={busy} onClick={() => void run(load)}>
        Load mailbox access
      </button>
      {opened && <MailboxCredentials mailboxes={available} />}
      {opened && mode === "unconfigured" && (
        <p>
          Webmail is not configured. Live mailbox login and sending are
          unavailable.
        </p>
      )}
      {opened && mode !== "unconfigured" && !connected && (
        <form onSubmit={connect}>
          <label>
            Assigned mailbox
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              required
            >
              <option value="">Choose mailbox</option>
              {available.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.address} ({row.permission})
                </option>
              ))}
            </select>
          </label>
          <label>
            Mailbox password
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button disabled={busy}>Connect mailbox</button>
        </form>
      )}
      {connected && (
        <>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api("/webmail/disconnect", "POST");
                setConnected(false);
                setListing(null);
                setMessage(null);
                setContacts([]);
                setSendAttempts([]);
                clearComposer();
              })
            }
          >
            Disconnect mailbox
          </button>
          <label>
            Folder
            <select
              disabled={busy}
              value={folder}
              onChange={(e) => {
                const path = e.target.value;
                setFolder(path);
                void run(() => refresh(path));
              }}
            >
              {folders.map((item) => (
                <option key={item.path}>{item.path}</option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => refresh());
            }}
          >
            <label>
              Search messages
              <input
                value={query}
                maxLength={200}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button disabled={busy}>Search</button>
          </form>
          <ul>
            {Array.from(
              (listing?.items ?? []).reduce((groups, row) => {
                const key = row.threadId ?? `uid:${row.uid}`;
                groups.set(key, [...(groups.get(key) ?? []), row]);
                return groups;
              }, new Map<string, Row[]>()),
            ).map(([threadId, rows]) => (
              <li key={threadId}>
                {rows.length > 1 && (
                  <strong>
                    Thread: {rows[0]?.subject || "(no subject)"} ({rows.length}{" "}
                    messages shown)
                  </strong>
                )}
                <ul>
                  {rows.map((row) => (
                    <li key={row.uid}>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            setMessage(
                              await api<Message>(
                                `/webmail/message?${new URLSearchParams({ folder, uid: String(row.uid), validity: listing!.uidValidity })}`,
                              ),
                            );
                          })
                        }
                      >
                        {row.seen ? "" : "Unread: "}
                        {row.threadDepth ? "↳ " : ""}
                        {row.subject || "(no subject)"}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {listing?.nextBeforeUid && (
            <button
              disabled={busy}
              onClick={() =>
                void run(() => refresh(folder, listing.nextBeforeUid!))
              }
            >
              Older messages
            </button>
          )}
          {message && (
            <article>
              <h3>{message.subject}</h3>
              <p>From: {message.from}</p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{message.text}</pre>
              {message.html && (
                <details>
                  <summary>Safe HTML view</summary>
                  <iframe
                    title="Message HTML"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={
                      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'none'\">" +
                      message.html
                    }
                  />
                </details>
              )}
              {message.attachments.map((item) => (
                <button
                  key={item.index}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const blob = await api<Blob>(
                        `/webmail/attachment?${new URLSearchParams({ folder, uid: String(message.uid), validity: listing!.uidValidity, index: String(item.index) })}`,
                        "GET",
                        undefined,
                        "blob",
                      );
                      const url = URL.createObjectURL(blob),
                        link = document.createElement("a");
                      link.href = url;
                      link.download = item.filename;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Download {item.filename} ({item.size} bytes)
                </button>
              ))}
              {writable && (
                <>
                  {folder === "Drafts" && (
                    <button disabled={busy} onClick={() => void run(loadDraft)}>
                      Edit draft as revised copy
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void run(() => act("read"))}
                  >
                    Mark read
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void run(() => act("unread"))}
                  >
                    Mark unread
                  </button>
                  <button
                    disabled={busy || folder === "Trash"}
                    onClick={() => void run(() => act("trash"))}
                  >
                    Move to Trash
                  </button>
                  <button
                    onClick={() => {
                      setTo(
                        message.from.match(/<([^>]+)>/)?.[1] ?? message.from,
                      );
                      setSubject(`Re: ${message.subject}`);
                      setText(`\n\n${message.text}`);
                      setReplyId(message.messageId);
                      setCc("");
                      setBcc("");
                      setFiles([]);
                      setDraftHtml(undefined);
                      setSendKey(undefined);
                      setReferences(
                        [
                          ...new Set([
                            ...(Array.isArray(message.references)
                              ? message.references
                              : message.references
                                ? [message.references]
                                : []),
                            ...(message.messageId ? [message.messageId] : []),
                          ]),
                        ].slice(-50),
                      );
                    }}
                  >
                    Reply
                  </button>
                </>
              )}
            </article>
          )}
          <section>
            <h3>Contacts</h3>
            {contacts.length ? (
              <ul>
                {contacts.map((contact) => (
                  <li key={contact.id}>
                    {contact.displayName
                      ? `${contact.displayName} <${contact.email}>`
                      : contact.email}
                    {writable && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const values = to
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                          if (!values.includes(contact.email))
                            setTo([...values, contact.email].join(", "));
                          setSendKey(undefined);
                        }}
                      >
                        Use {contact.email}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/webmail/contacts/${contact.id}`,
                            "DELETE",
                          );
                          setContacts((rows) =>
                            rows.filter((row) => row.id !== contact.id),
                          );
                        })
                      }
                    >
                      Remove {contact.email}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No contacts saved for this mailbox.</p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const saved = await api<Contact>(
                    "/webmail/contacts",
                    "POST",
                    { displayName: contactName, email: contactEmail },
                  );
                  setContacts((rows) => [
                    ...rows.filter((row) => row.id !== saved.id),
                    saved,
                  ]);
                  setContactName("");
                  setContactEmail("");
                });
              }}
            >
              <label>
                Contact name
                <input
                  value={contactName}
                  maxLength={100}
                  onChange={(event) => setContactName(event.target.value)}
                />
              </label>
              <label>
                Contact email
                <input
                  type="email"
                  required
                  value={contactEmail}
                  maxLength={254}
                  onChange={(event) => setContactEmail(event.target.value)}
                />
              </label>
              <button disabled={busy}>Save contact</button>
            </form>
          </section>
          {sendAttempts.length > 0 && (
            <section>
              <h3>Recent send attempts</h3>
              <p>
                These content-free records survive a browser restart. Inspect
                Sent before starting another message after an uncertain result.
                A missing Sent copy does not prove delivery failed. Check with
                the recipient before sending again to avoid duplicates.
              </p>
              <ul>
                {sendAttempts.map((attempt) => (
                  <li key={attempt.id}>
                    {attempt.state} at{" "}
                    {new Date(attempt.createdAt).toLocaleString()}
                    {attempt.state === "accepted"
                      ? ` — ${attempt.acceptedRecipientCount ?? 0} accepted, ${attempt.rejectedRecipientCount ?? 0} rejected${attempt.sentCopyStored ? ", Sent copy saved" : ", no confirmed Sent copy"}`
                      : attempt.resolution
                        ? ` — resolved as ${attempt.resolution === "confirmed_sent" ? "found in Sent" : "not found in Sent"}`
                        : " — inspect Sent; this attempt will not be submitted automatically again"}
                    {writable && attempt.state === "uncertain" && !attempt.resolution && (
                      <span className="actions">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              resolveSendAttempt(attempt.id, "confirmed_sent"),
                            )
                          }
                        >
                          I found this message in Sent
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              resolveSendAttempt(
                                attempt.id,
                                "confirmed_not_sent",
                              ),
                            )
                          }
                        >
                          I checked Sent; this message is not there
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {writable && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => compose(false));
              }}
            >
              <h3>Compose</h3>
              {[
                ["To", to, setTo],
                ["Cc", cc, setCc],
                ["Bcc", bcc, setBcc],
              ].map(([label, value, set]) => (
                <label key={String(label)}>
                  {String(label)} (comma separated)
                  <input
                    value={value as string}
                    onChange={(e) => {
                      (set as (value: string) => void)(e.target.value);
                      setSendKey(undefined);
                    }}
                  />
                </label>
              ))}
              <label>
                Subject
                <input
                  value={subject}
                  maxLength={998}
                  onChange={(e) => {
                    setSubject(e.target.value);
                    setSendKey(undefined);
                  }}
                />
              </label>
              <label>
                Message
                <textarea
                  value={text}
                  maxLength={1000000}
                  onChange={(e) => {
                    setText(e.target.value);
                    setDraftHtml(undefined);
                    setSendKey(undefined);
                  }}
                />
              </label>
              <label>
                Attachments (up to 5, 1 MiB each)
                <input
                  type="file"
                  multiple
                  onChange={(e) => {
                    const chosen = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void run(async () => {
                      if (
                        chosen.length > 5 ||
                        chosen.some((file) => file.size > 1024 * 1024)
                      )
                        throw new Error("Attachment limit exceeded");
                      const values = await Promise.all(
                        chosen.map(
                          (file) =>
                            new Promise<{
                              filename: string;
                              contentBase64: string;
                            }>((resolve, reject) => {
                              const reader = new FileReader();
                              reader.onerror = () =>
                                reject(new Error("Cannot read attachment"));
                              reader.onload = () =>
                                resolve({
                                  filename: file.name,
                                  contentBase64:
                                    String(reader.result).split(",")[1] ?? "",
                                });
                              reader.readAsDataURL(file);
                            }),
                        ),
                      );
                      setFiles(values);
                      setSendKey(undefined);
                    });
                  }}
                />
              </label>
              <p>{files.map((file) => file.filename).join(", ")}</p>
              <button disabled={busy}>Send</button>
              {sendKey && (
                <p>
                  Resolve the uncertain attempt above before starting a new
                  send attempt.
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => compose(true))}
              >
                Save draft
              </button>
            </form>
          )}
        </>
      )}
      {isOwner && (
        <details>
          <summary>Manage mailbox access</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(
                  `/organizations/${orgId}/mailboxes/${assigned}/access`,
                  "PUT",
                  { userId: member, permission },
                );
                setNotice("Mailbox access updated.");
                await load();
              });
            }}
          >
            <label>
              Mailbox
              <select
                required
                value={assigned}
                onChange={(e) => setAssigned(e.target.value)}
              >
                <option value="">Choose mailbox</option>
                {mailboxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.address}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Verified member
              <select
                required
                value={member}
                onChange={(e) => setMember(e.target.value)}
              >
                <option value="">Choose member</option>
                {members.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Permission
              <select
                value={permission}
                onChange={(e) => setPermission(e.target.value)}
              >
                <option value="read">Read only</option>
                <option value="write">Read and send</option>
                <option value="revoke">Revoke access</option>
              </select>
            </label>
            <button disabled={busy}>Update access</button>
          </form>
        </details>
      )}
    </section>
  );
}
