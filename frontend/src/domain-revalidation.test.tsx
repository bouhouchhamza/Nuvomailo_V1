import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Domains } from "./pages/domains";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => mocks.api.mockReset());
const domain = {
  id: "domain",
  name: "release.example.test",
  verification_status: "verified" as const,
  verification_attempts: 1,
  verification_expires_at: "2026-10-22T00:00:00Z",
  last_attempt_at: null,
  dnsChallenge: {
    type: "TXT",
    name: "_nuvomailo-verification.release.example.test",
    value: "proof",
  },
  mailReadiness: "not-configured" as const,
  mail_ever_activated: false,
  revalidation_state: "warning" as const,
  revalidation_grace_expires_at: "2026-11-14T00:00:00Z",
};
it("revalidates ownership and clears release passwords after explicit typed-name consent", async () => {
  mocks.api.mockResolvedValue({});
  const reload = vi.fn(async () => {}),
    actor = userEvent.setup();
  render(
    <Domains
      orgId="org"
      domains={[domain]}
      canManage
      reload={reload}
      isOwner
    />,
  );
  expect(screen.getByText(/Revalidation: warning/)).toBeInTheDocument();
  await actor.click(screen.getByText("Revalidate DNS ownership"));
  expect(mocks.api).toHaveBeenCalledWith(
    "/organizations/org/domains/domain/revalidate",
    "POST",
  );
  await actor.click(screen.getByText("Prepare domain release"));
  await actor.type(screen.getByLabelText("Confirm domain name"), domain.name);
  await actor.type(
    screen.getByLabelText("Dashboard password"),
    "SyntheticDashboard123!",
  );
  await actor.selectOptions(screen.getByLabelText("Reason"), "test-claim");
  await actor.click(screen.getByText("Release empty domain"));
  expect(mocks.api).toHaveBeenCalledWith(
    "/organizations/org/domains/domain/release",
    "POST",
    {
      confirmName: domain.name,
      dashboardPassword: "SyntheticDashboard123!",
      reason: "test-claim",
    },
  );
  expect(screen.queryByLabelText("Dashboard password")).not.toBeInTheDocument();
  expect(reload).toHaveBeenCalled();
});
it("does not offer release for domains with activation history", () => {
  render(
    <Domains
      orgId="org"
      domains={[{ ...domain, mail_ever_activated: true }]}
      canManage
      reload={async () => {}}
      isOwner
    />,
  );
  expect(screen.queryByText("Prepare domain release")).not.toBeInTheDocument();
});
