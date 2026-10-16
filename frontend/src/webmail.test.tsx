import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Webmail } from "./pages/webmail";
import type { Mailbox } from "./types";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => {
  mocks.api.mockReset();
});
it("loads a private draft into a revised copy preserving hidden recipients", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path === "/webmail"
      ? {
          mode: "local-lab",
          mailboxes: [
            {
              id: "box",
              address: "pilot@tenant-a.lab.invalid",
              permission: "write",
            },
          ],
        }
      : path === "/webmail/folders"
        ? [{ path: "INBOX" }, { path: "Drafts" }]
        : path.startsWith("/webmail/messages")
          ? {
              items: [
                {
                  uid: 7,
                  subject: "Draft round-trip",
                  seen: true,
                  threadId: "thread-a",
                  threadDepth: 0,
                  visibleThreadSize: 2,
                },
                {
                  uid: 8,
                  subject: "Re: Draft round-trip",
                  seen: false,
                  threadId: "thread-a",
                  threadDepth: 1,
                  visibleThreadSize: 2,
                },
              ],
              uidValidity: "5",
              nextBeforeUid: null,
            }
          : path.startsWith("/webmail/message?")
            ? {
                uid: 7,
                subject: "Draft round-trip",
                from: "pilot@tenant-a.lab.invalid",
                to: { value: [{ address: "to@tenant-a.lab.invalid" }] },
                bcc: { value: [{ address: "hidden@tenant-a.lab.invalid" }] },
                text: "Draft body",
                html: null,
                attachments: [],
              }
            : path === "/webmail/draft"
              ? { draftSaved: true }
              : {},
  );
  render(
    <Webmail
      orgId="org"
      mailboxes={[{ id: "box" } as Mailbox]}
      members={[]}
      isOwner={false}
    />,
  );
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Load mailbox access"));
  await actor.selectOptions(
    await screen.findByLabelText("Assigned mailbox"),
    "box",
  );
  await actor.type(screen.getByLabelText("Mailbox password"), "synthetic-only");
  await actor.click(screen.getByRole("button", { name: "Connect mailbox" }));
  await actor.selectOptions(await screen.findByLabelText("Folder"), "Drafts");
  expect(
    await screen.findByText("Thread: Draft round-trip (2 messages shown)"),
  ).toBeInTheDocument();
  await actor.click(await screen.findByText("Draft round-trip"));
  await actor.click(await screen.findByText("Edit draft as revised copy"));
  expect(screen.getByLabelText("Bcc (comma separated)")).toHaveValue(
    "hidden@tenant-a.lab.invalid",
  );
  expect(screen.getByLabelText("Message")).toHaveValue("Draft body");
  await actor.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Draft saved.")).toBeInTheDocument();
  expect(mocks.api).toHaveBeenCalledWith(
    "/webmail/draft",
    "POST",
    expect.objectContaining({
      bcc: ["hidden@tenant-a.lab.invalid"],
      text: "Draft body",
    }),
  );
});
it("unconfigured webmail exposes no credential or send form", async () => {
  mocks.api.mockResolvedValue({ mode: "unconfigured", mailboxes: [] });
  render(<Webmail orgId="org" mailboxes={[]} members={[]} isOwner={false} />);
  await userEvent.click(screen.getByText("Load mailbox access"));
  expect(
    await screen.findByText(/Live mailbox login and sending are unavailable/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Mailbox password")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Send" }),
  ).not.toBeInTheDocument();
});
it("clears submitted mailbox password and keeps read-only sessions from sending", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path === "/webmail/send-attempts"
      ? [{ id: "read-only-attempt", state: "uncertain", resolution: null,
          createdAt: "2026-10-16T12:00:00Z" }]
      : path === "/webmail"
      ? {
          mode: "local-lab",
          mailboxes: [
            {
              id: "box",
              address: "pilot@tenant-a.lab.invalid",
              permission: "read",
            },
          ],
        }
      : path === "/webmail/folders"
        ? [{ path: "INBOX" }]
        : path.startsWith("/webmail/messages")
          ? {
              items: [{ uid: 1, subject: "Synthetic message", seen: false }],
              uidValidity: "5",
              nextBeforeUid: null,
            }
          : {},
  );
  render(
    <Webmail
      orgId="org"
      mailboxes={[{ id: "box" } as Mailbox]}
      members={[]}
      isOwner={false}
    />,
  );
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Load mailbox access"));
  await actor.selectOptions(
    await screen.findByLabelText("Assigned mailbox"),
    "box",
  );
  await actor.type(screen.getByLabelText("Mailbox password"), "synthetic-only");
  await actor.click(screen.getByRole("button", { name: "Connect mailbox" }));
  expect(
    await screen.findByText("Unread: Synthetic message"),
  ).toBeInTheDocument();
  expect(mocks.api).toHaveBeenCalledWith("/webmail/connect", "POST", {
    mailboxId: "box",
    password: "synthetic-only",
  });
  expect(
    screen.queryByRole("button", { name: "Send" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "I found this message in Sent" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "I checked Sent; this message is not there" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Mailbox password")).not.toBeInTheDocument();
  await actor.click(screen.getByRole("button", { name: "Disconnect mailbox" }));
  expect(await screen.findByLabelText("Mailbox password")).toHaveValue("");
});
it("keeps contacts scoped to the connected mailbox and can use them as recipients", async () => {
  let contacts = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Existing",
      email: "existing@tenant-a.lab.invalid",
    },
  ];
  mocks.api.mockImplementation(
    async (path: string, method?: string, body?: unknown) => {
      if (path === "/webmail")
        return {
          mode: "local-lab",
          mailboxes: [
            {
              id: "box",
              address: "pilot@tenant-a.lab.invalid",
              permission: "write",
            },
          ],
        };
      if (path === "/webmail/folders") return [{ path: "INBOX" }];
      if (path.startsWith("/webmail/messages"))
        return { items: [], uidValidity: "5", nextBeforeUid: null };
      if (path === "/webmail/contacts" && method === "POST") {
        const value = body as { displayName: string; email: string };
        const saved = {
          id: "22222222-2222-4222-8222-222222222222",
          ...value,
        };
        contacts = [...contacts, saved];
        return saved;
      }
      if (path === "/webmail/contacts") return contacts;
      if (path === "/webmail/send")
        return {
          smtpAccepted: true,
          sentCopyStored: true,
          draftSaved: false,
          rejectedRecipients: [],
        };
      return {};
    },
  );
  render(
    <Webmail
      orgId="org"
      mailboxes={[{ id: "box" } as Mailbox]}
      members={[]}
      isOwner={false}
    />,
  );
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Load mailbox access"));
  await actor.selectOptions(
    await screen.findByLabelText("Assigned mailbox"),
    "box",
  );
  await actor.type(screen.getByLabelText("Mailbox password"), "synthetic-only");
  await actor.click(screen.getByRole("button", { name: "Connect mailbox" }));
  await actor.click(
    await screen.findByRole("button", {
      name: "Use existing@tenant-a.lab.invalid",
    }),
  );
  expect(screen.getByLabelText("To (comma separated)")).toHaveValue(
    "existing@tenant-a.lab.invalid",
  );
  await actor.type(screen.getByLabelText("Contact name"), "New contact");
  await actor.type(
    screen.getByLabelText("Contact email"),
    "new@tenant-a.lab.invalid",
  );
  await actor.click(screen.getByRole("button", { name: "Save contact" }));
  expect(mocks.api).toHaveBeenCalledWith("/webmail/contacts", "POST", {
    displayName: "New contact",
    email: "new@tenant-a.lab.invalid",
  });
  expect(
    await screen.findByText("New contact <new@tenant-a.lab.invalid>"),
  ).toBeInTheDocument();
  await actor.type(screen.getByLabelText("Subject"), "Idempotent send");
  await actor.type(screen.getByLabelText("Message"), "Synthetic body");
  await actor.click(screen.getByRole("button", { name: "Send" }));
  expect(mocks.api).toHaveBeenCalledWith(
    "/webmail/send",
    "POST",
    expect.objectContaining({
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      to: ["existing@tenant-a.lab.invalid"],
    }),
  );
});
it("requires explicit reconciliation before replacing an uncertain send key", async () => {
  let resolution: "confirmed_not_sent" | null = null;
  mocks.api.mockImplementation(
    async (path: string, _method?: string, body?: unknown) => {
    if (path === "/webmail")
      return {
        mode: "local-lab",
        mailboxes: [
          {
            id: "box",
            address: "pilot@tenant-a.lab.invalid",
            permission: "write",
          },
        ],
      };
    if (path === "/webmail/folders") return [{ path: "INBOX" }];
    if (path === "/webmail/contacts") return [];
    if (path === "/webmail/send-attempts")
      return [
        {
          id: "11111111-1111-4111-8111-111111111111",
          state: "uncertain",
          resolution,
          resolvedAt: resolution ? "2026-10-15T12:00:02.000Z" : null,
          sentCopyStored: null,
          acceptedRecipientCount: null,
          rejectedRecipientCount: null,
          createdAt: "2026-10-15T12:00:00.000Z",
          finishedAt: "2026-10-15T12:00:01.000Z",
        },
      ];
    if (path.startsWith("/webmail/messages"))
      return { items: [], uidValidity: "5", nextBeforeUid: null };
    if (path === "/webmail/send")
      throw new Error("Send outcome is uncertain; inspect Sent");
    if (path.endsWith("/resolve")) {
      resolution = (body as { resolution: "confirmed_not_sent" }).resolution;
      return { resolution };
    }
    return {};
    },
  );
  render(
    <Webmail
      orgId="org"
      mailboxes={[{ id: "box" } as Mailbox]}
      members={[]}
      isOwner={false}
    />,
  );
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Load mailbox access"));
  await actor.selectOptions(
    await screen.findByLabelText("Assigned mailbox"),
    "box",
  );
  await actor.type(screen.getByLabelText("Mailbox password"), "synthetic-only");
  await actor.click(screen.getByRole("button", { name: "Connect mailbox" }));
  expect(
    await screen.findByText(
      /this attempt will not be submitted automatically again/,
    ),
  ).toBeInTheDocument();
  await actor.type(
    screen.getByLabelText("To (comma separated)"),
    "recipient@tenant-a.lab.invalid",
  );
  await actor.type(screen.getByLabelText("Message"), "Synthetic uncertain");
  await actor.click(screen.getByRole("button", { name: "Send" }));
  const reconcile = await screen.findByRole("button", {
    name: "I checked Sent; this message is not there",
  });
  await actor.click(reconcile);
  expect(mocks.api).toHaveBeenCalledWith(
    "/webmail/send-attempts/11111111-1111-4111-8111-111111111111/resolve",
    "POST",
    { resolution: "confirmed_not_sent" },
  );
  expect(
    screen.queryByRole("button", {
      name: "I checked Sent; this message is not there",
    }),
  ).not.toBeInTheDocument();
});
