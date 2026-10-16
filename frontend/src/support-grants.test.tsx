import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SupportGrants, SupportDiagnostics } from "./pages/support-grants";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => mocks.api.mockReset());
it("support consent clears the reauthentication password and exposes revocation", async () => {
  const grant = {
    id: "grant",
    staff_user_id: "staff",
    expires_at: new Date(Date.now() + 900000).toISOString(),
    revoked_at: null,
  };
  mocks.api.mockImplementation(async (_path: string, method?: string) =>
    method === "POST" ? grant : [grant],
  );
  render(<SupportGrants orgId="org" />);
  expect(mocks.api).not.toHaveBeenCalled();
  const actor = userEvent.setup();
  await actor.type(screen.getByLabelText("Support agent ID"), "staff");
  await actor.type(
    screen.getByLabelText("Dashboard password"),
    "SyntheticPassword123!",
  );
  await actor.click(screen.getByText("Grant diagnostic access"));
  expect(await screen.findByText("Revoke grant")).toBeInTheDocument();
  expect(screen.getByLabelText("Dashboard password")).toHaveValue("");
  expect(mocks.api).toHaveBeenCalledWith(
    "/organizations/org/support-grants",
    "POST",
    {
      staffUserId: "staff",
      minutes: 15,
      dashboardPassword: "SyntheticPassword123!",
    },
  );
  await actor.click(screen.getByText("Revoke grant"));
  expect(mocks.api).toHaveBeenCalledWith(
    "/organizations/org/support-grants/grant",
    "DELETE",
  );
});
it("staff diagnostics clear an earlier result when another grant is denied", async () => {
  mocks.api
    .mockResolvedValueOnce({ resources: { domains: 123 } })
    .mockRejectedValueOnce(new Error("Active support grant not found"));
  render(<SupportDiagnostics />);
  const actor = userEvent.setup();
  await actor.type(screen.getByLabelText("Support grant ID"), "grant-one");
  await actor.click(screen.getByText("Read authorized diagnostics"));
  expect(await screen.findByText(/123/)).toBeInTheDocument();
  await actor.clear(screen.getByLabelText("Support grant ID"));
  await actor.type(screen.getByLabelText("Support grant ID"), "grant-two");
  await actor.click(screen.getByText("Read authorized diagnostics"));
  expect(
    await screen.findByText("Active support grant not found"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/123/)).not.toBeInTheDocument();
});
