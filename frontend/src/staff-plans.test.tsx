import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StaffPlans } from "./pages/staff-plans";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => {
  mocks.api.mockReset();
  vi.restoreAllMocks();
});
const plan = {
  id: "synthetic",
  name: "Synthetic plan",
  currency: "USD",
  active: true,
  monthly_minor: 0,
  yearly_minor: 0,
  max_domains: 2,
  max_mailboxes: 4,
  max_members: 3,
  max_quota_mb: 200,
  storage_mb: 800,
  max_mailboxes_per_domain: 4,
};
it("staff viewers can inspect plans without editing controls", async () => {
  mocks.api.mockResolvedValue([plan]);
  render(<StaffPlans operator={false} />);
  await userEvent.click(screen.getByText("Load staff plans"));
  expect(
    await screen.findByText(/Synthetic plan \(synthetic\)/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save plan catalog entry" }),
  ).not.toBeInTheDocument();
});
it("operator edits preserve all limits and require explicit impact confirmation", async () => {
  mocks.api.mockResolvedValue([plan]);
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<StaffPlans operator />);
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Load staff plans"));
  await actor.click(
    await screen.findByRole("button", { name: "Edit Synthetic plan" }),
  );
  await actor.click(
    screen.getByRole("button", { name: "Save plan catalog entry" }),
  );
  expect(mocks.api).toHaveBeenCalledTimes(1);
  confirmation.mockReturnValue(true);
  await actor.click(
    screen.getByRole("button", { name: "Save plan catalog entry" }),
  );
  expect(await screen.findByText(/Catalog entry saved/)).toBeInTheDocument();
  expect(mocks.api).toHaveBeenCalledWith("/platform/plans/synthetic", "PUT", {
    name: plan.name,
    currency: "USD",
    active: true,
    monthlyMinor: 0,
    yearlyMinor: 0,
    maxDomains: 2,
    maxMailboxes: 4,
    maxMembers: 3,
    maxQuotaMb: 200,
    storageMb: 800,
    maxMailboxesPerDomain: 4,
  });
});
