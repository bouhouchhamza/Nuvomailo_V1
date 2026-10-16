import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./app";
import { createApi, ApiError } from "./api";

const user = {
  id: "user-1",
  email: "owner@example.test",
  created_at: "2026-10-14T12:00:00Z",
};
const org = {
  id: "org-1",
  name: "Example school",
  slug: "example-school",
  role: "owner",
  created_at: user.created_at,
};
const domain = {
  id: "domain-1",
  name: "school.example",
  verification_status: "verified",
  verification_attempts: 1,
  verification_expires_at: "2026-10-21T12:00:00Z",
  last_attempt_at: null,
  dnsChallenge: {
    type: "TXT",
    name: "_nuvomailo-verification.school.example",
    value: "challenge",
  },
  mailReadiness: "not-configured",
};
let role = "owner",
  orgs: unknown[],
  domains: unknown[],
  mailboxes: unknown[];
const calls: { path: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  role = "owner";
  orgs = [org];
  domains = [domain];
  mailboxes = [];
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ path: input, method, body });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (input === "/api/auth/login")
        return json({ user, accessToken: "test-token", expiresIn: 900 });
      if (input === "/api/auth/refresh") return json({error:"No active session"},401);
      if (input === "/api/auth/logout") return new Response(null,{status:204});
      if (input === "/api/auth/register")
        return json({ id: user.id, email: user.email }, 201);
      if (input === "/api/auth/me") return json(user);
      if (input === "/api/organizations") {
        if (method === "POST") {
          orgs = [org];
          return json(org, 201);
        }
        return json(orgs.map((o) => ({ ...(o as object), role })));
      }
      if (input.includes("/provisioning-requests?"))
        return json({
          items: [
            {
              id: "job-1",
              mailbox_id: "box-1",
              address: "hello@school.example",
              operation: "create",
              revision: 1,
              desired_status: "active",
              quota_mb: 100,
              state: "failed",
              attempts: 5,
              max_attempts: 5,
              available_at: user.created_at,
              last_error_code: "PROVIDER_UNAVAILABLE",
              lease_expires_at: null,
            },
          ],
          nextCursor: null,
        });
      if (input.includes("/audit-events?"))
        return json({
          items: [
            {
              id: "1",
              actor_user_id: user.id,
              action: "mailbox.create_requested",
              resource_id: "box-1",
              metadata: {},
              created_at: user.created_at,
            },
          ],
          nextCursor: null,
        });
      if (input.endsWith("/retry"))
        return json({ id: "job-1", state: "pending" }, 202);
      if (input.endsWith("/domains")) return json(domains);
      if (input.endsWith("/members")) return json([{ ...user, role }]);
      if (input.endsWith("/mailboxes")) {
        if (method === "POST") {
          mailboxes = [
            {
              id: "box-1",
              address: `${body.localPart}@school.example`,
              quota_mb: body.quotaMb,
              provisioning_status: "pending_provisioning",
              liveMailAvailable: false,
              provisioningMode: "pending-phase-6",
            },
          ];
          return json(mailboxes[0], 202);
        }
        return json(mailboxes);
      }
      return json({ error: "Unexpected test request" }, 500);
    }),
  );
});
async function login() {
  const actor = userEvent.setup();
  await actor.type(await screen.findByLabelText("Email address"), user.email);
  await actor.type(screen.getByLabelText("Password"), "LongPassword123!");
  await actor.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: org.name });
  await screen.findByText("Mailbox configurations");
  return actor;
}
describe("dashboard workflows", () => {
  it("signs in, loads real-shaped data, requests a mailbox and signs out", async () => {
    render(<App />);
    const actor = await login();
    await actor.click(screen.getByRole("button", { name: "Mailboxes" }));
    expect(
      screen.getByText(/cannot send or receive email/),
    ).toBeInTheDocument();
    await actor.type(screen.getByLabelText("Mailbox name"), "hello");
    await actor.selectOptions(screen.getByLabelText("Quota"), "200");
    await actor.click(screen.getByRole("button", { name: "Request mailbox" }));
    expect(await screen.findByText("hello@school.example")).toBeInTheDocument();
    expect(screen.getByText("pending provisioning")).toBeInTheDocument();
    expect(
      calls.find((c) => c.path.endsWith("/mailboxes") && c.method === "POST")
        ?.body,
    ).toEqual({ domainId: "domain-1", localPart: "hello", quotaMb: 200 });
    await actor.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      screen.getByRole("heading", { name: "Welcome back" }),
    ).toBeInTheDocument();
  });
  it("lets a member view domains without management controls", async () => {
    role = "member";
    render(<App />);
    const actor = await login();
    await actor.click(screen.getByRole("button", { name: "Domains" }));
    expect(screen.getByText("school.example")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add domain" }),
    ).not.toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: "Members" }));
    expect(
      screen.queryByRole("button", { name: "Add member" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Operations" }),
    ).not.toBeInTheDocument();
  });
  it("shows queue failures and audit history and submits an explicit retry", async () => {
    render(<App />);
    const actor = await login();
    await actor.click(screen.getByRole("button", { name: "Operations" }));
    expect(await screen.findByText("PROVIDER_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("mailbox.create_requested")).toBeInTheDocument();
    expect(screen.getByText("dead letter")).toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: "Retry request" }));
    expect(
      calls.some(
        (c) =>
          c.path ===
            "/api/organizations/org-1/provisioning-requests/job-1/retry" &&
          c.method === "POST",
      ),
    ).toBe(true);
  });
  it("offers resume according to desired suspension while actual status is still pending", async () => {
    mailboxes = [
      {
        id: "box-1",
        address: "hello@school.example",
        quota_mb: 100,
        desired_status: "suspended",
        desired_revision: 2,
        applied_revision: 0,
        observed_status: "unknown",
        observed_at: null,
        observed_quota_mb: null,
        last_provisioning_error: null,
        provisioning_status: "pending_provisioning",
      },
    ];
    render(<App />);
    const actor = await login();
    await actor.click(screen.getByRole("button", { name: "Mailboxes" }));
    expect(
      screen.getByRole("button", { name: "Request resume" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No infrastructure observation yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Desired: suspended · revision 2"),
    ).toBeInTheDocument();
  });
  it("supports registration and the empty organization creation flow", async () => {
    orgs = [];
    render(<App />);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole("button", { name: "New here? Create an account" }),
    );
    await actor.type(await screen.findByLabelText("Email address"), user.email);
    await actor.type(screen.getByLabelText("Password"), "LongPassword123!");
    await actor.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Your workspace starts here." });
    await actor.click(
      screen.getByRole("button", { name: "Create your first organization" }),
    );
    await actor.type(
      screen.getByLabelText("Organization name"),
      "Example school",
    );
    await actor.type(screen.getByLabelText("Unique slug"), "example-school");
    await actor.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    await screen.findByRole("heading", { name: org.name });
    expect(calls.some((c) => c.path === "/api/auth/register")).toBe(true);
  });
  it("displays backend errors on sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Invalid email or password" }), {
            status: 401,
          }),
      ),
    );
    render(<App />);
    const actor = userEvent.setup();
    await actor.type(await screen.findByLabelText("Email address"), user.email);
    await actor.type(screen.getByLabelText("Password"), "bad");
    await actor.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid email or password",
    );
  });
  it("shows pending DNS instructions and prohibits mailbox creation until verification", async () => {
    domains = [{ ...domain, verification_status: "pending" }];
    render(<App />);
    const actor = await login();
    await actor.click(screen.getByRole("button", { name: "Domains" }));
    expect(
      screen.getByText("_nuvomailo-verification.school.example"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check DNS ownership" }),
    ).toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: "Mailboxes" }));
    expect(
      screen.getByText("Verify a domain before creating a mailbox."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Request mailbox" }),
    ).not.toBeInTheDocument();
  });
});
describe("central API client", () => {
  it("clears expired sessions and preserves HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Expired" }), { status: 401 }),
      ),
    );
    const expired = vi.fn();
    const api = createApi("expired-token", expired);
    await expect(api("/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer expired-token" },
      }),
    );
  });
  it("surfaces validation details and accepts empty 204 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: "Invalid request",
              issues: [{ message: "Invalid domain" }],
            }),
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const api = createApi();
    await expect(api("/domains", "POST", {})).rejects.toThrow("Invalid domain");
    await expect(api("/members/1", "DELETE")).resolves.toBeUndefined();
  });
});
