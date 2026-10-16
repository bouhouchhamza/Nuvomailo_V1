import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Billing } from "./pages/billing";
import { Security } from "./pages/security";
import { Invitations } from "./pages/invitations";
import { Platform } from "./pages/platform";
const mocks = vi.hoisted(() => ({ api: vi.fn(), endSession: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => {
  mocks.api.mockReset();
  mocks.endSession.mockReset();
});
it("billing labels sandbox and keeps checkout disabled without a configured provider", async () => {
  const plan = {
    id: "development",
    name: "Development sandbox",
    state: "trial",
    max_domains: 10,
    max_mailboxes: 100,
    max_quota_mb: 200,
    storage_mb: "20000",
    canExpand: true,
  };
  mocks.api.mockImplementation(async (path: string) =>
    path === "/billing/plans"
      ? { plans: [plan] }
      : {
          entitlements: plan,
          invoices: [],
          renewals: [
            {
              id: "renewal",
              plan_id: "development",
              period: "monthly",
              prior_period_end: "2026-10-15T00:00:00.000Z",
              amount_minor: 0,
              currency: "USD",
              state: "uncertain",
              attempts: 5,
              last_error_code: "OUTCOME_UNKNOWN",
            },
          ],
          providerAvailable: false,
          usageMetering: {
            rollupState: "fresh",
            coverageComplete: true,
            billingEligible: false,
            observedUsageBytes: "4096",
            observedMessageCount: "3",
            mailboxCount: 1,
            freshMailboxCount: 1,
            staleMailboxCount: 0,
            unknownMailboxCount: 0,
          },
        },
  );
  render(<Billing orgId="org" isOwner />);
  await screen.findByText(/Development sandbox — trial/);
  expect(
    screen.getByRole("button", { name: "Create sandbox checkout" }),
  ).toBeDisabled();
  expect(screen.getByText(/No real payments/)).toBeInTheDocument();
  expect(screen.getByText(/4096 bytes across 1 mailboxes/)).toBeInTheDocument();
  expect(screen.getByText(/cannot create a charge/)).toBeInTheDocument();
  expect(screen.getByText(/requires operator reconciliation/)).toBeInTheDocument();
});
it("security password change revokes identity state and sends only the intended request", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path === "/auth/mfa" ? { enabled: false } : [],
  );
  render(<Security />);
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Security settings"));
  await actor.type(
    await screen.findByLabelText("Current password"),
    "CurrentPassword123!",
  );
  await actor.type(
    screen.getByLabelText("New password"),
    "ReplacementPassword123!",
  );
  await actor.click(
    screen.getByRole("button", { name: "Change password and revoke sessions" }),
  );
  expect(mocks.api).toHaveBeenCalledWith("/auth/change-password", "POST", {
    currentPassword: "CurrentPassword123!",
    password: "ReplacementPassword123!",
  });
  expect(mocks.endSession).toHaveBeenCalled();
});
it("accepts an in-app invitation and refreshes organization membership", async () => {
  let accepted = false;
  const reload = vi.fn(async () => {});
  mocks.api.mockImplementation(async (path: string) =>
    path === "/invitations"
      ? accepted
        ? []
        : [
            {
              id: "invite",
              organization_name: "Inviting team",
              role: "member",
              expires_at: "2026-10-21",
            },
          ]
      : (accepted = true),
  );
  render(<Invitations reload={reload} />);
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Check invitations"));
  await actor.click(await screen.findByText("Accept invitation"));
  expect(mocks.api).toHaveBeenCalledWith("/invitations/invite/accept", "POST");
  expect(reload).toHaveBeenCalled();
  await screen.findByText(/No available invitations/);
});
it("platform denies ordinary owner access without displaying staff data", async () => {
  mocks.api.mockRejectedValue(
    new Error("Staff session with recent MFA required"),
  );
  render(<Platform />);
  await userEvent.click(screen.getByText("Platform administration"));
  await userEvent.click(screen.getByText("Open staff directory"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Staff session with recent MFA required",
  );
  expect(screen.queryByText("Inspect pending queue")).not.toBeInTheDocument();
});
