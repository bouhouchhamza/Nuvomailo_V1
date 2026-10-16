import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mailboxes } from "./pages/mailboxes";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => mocks.api.mockReset());
const box = {
  id: "box",
  domain_id: "domain",
  address: "usage@example.test",
  quota_mb: 100,
  desired_status: "active" as const,
  desired_revision: 1,
  applied_revision: 1,
  observed_status: "active" as const,
  observed_quota_mb: 100,
  observed_at: "2026-10-15T10:00:00Z",
  last_provisioning_error: null,
  provisioning_status: "active" as const,
  provisioningMode: "pending-phase-6" as const,
  liveMailAvailable: false as const,
  usageState: "fresh" as const,
  usageBytes: 4096,
  messageCount: 3,
  usageObservedAt: "2026-10-15T10:00:00Z",
  usageLastErrorCode: null,
  usageRefreshAvailable: true,
};
it("shows measured usage and queues an explicit refresh without claiming immediate application", async () => {
  mocks.api.mockResolvedValue({ state: "pending" });
  const reload = vi.fn(async () => {});
  render(
    <Mailboxes
      orgId="org"
      domains={[]}
      mailboxes={[box]}
      canManage
      reload={reload}
    />,
  );
  expect(
    screen.getByText(/Usage: 4 KiB · 3 messages · fresh/),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByText("Request usage refresh"));
  expect(mocks.api).toHaveBeenCalledWith(
    "/organizations/org/mailboxes/box/usage-refresh",
    "POST",
  );
  expect(reload).toHaveBeenCalled();
});
it("keeps refresh disabled when no provider is enabled and labels unknown usage", () => {
  render(
    <Mailboxes
      orgId="org"
      domains={[]}
      mailboxes={[
        {
          ...box,
          usageState: "unknown",
          usageBytes: null,
          messageCount: null,
          usageObservedAt: null,
          usageRefreshAvailable: false,
        },
      ]}
      canManage
      reload={async () => {}}
    />,
  );
  expect(screen.getByText("Usage: unknown")).toBeInTheDocument();
  expect(screen.getByText("Request usage refresh")).toBeDisabled();
});
