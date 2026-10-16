import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MailRouting } from "./pages/mail-routing";
import type { Domain, Mailbox } from "./types";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => {
  mocks.api.mockReset();
});
it("members can read routing without mutation controls", async () => {
  mocks.api.mockResolvedValue([]);
  render(
    <MailRouting orgId="org" domains={[]} mailboxes={[]} canManage={false} />,
  );
  await userEvent.click(screen.getByText("Load mail routes"));
  expect(
    screen.queryByRole("button", { name: "Queue mail route" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/external destinations are not enabled/),
  ).toBeInTheDocument();
});
it("queues an internal alias and describes intent separately from delivery", async () => {
  mocks.api.mockImplementation(async (_path: string, method: string) =>
    method === "PUT" ? { generation: 1 } : [],
  );
  render(
    <MailRouting
      orgId="org"
      domains={[
        {
          id: "domain",
          name: "tenant-a.lab.invalid",
          verification_status: "verified",
        } as Domain,
      ]}
      mailboxes={[
        {
          id: "box",
          address: "pilot@tenant-a.lab.invalid",
          desired_status: "active",
        } as Mailbox,
      ]}
      canManage
    />,
  );
  const actor = userEvent.setup();
  await actor.selectOptions(screen.getByLabelText("Source domain"), "domain");
  await actor.type(screen.getByLabelText("Source address local part"), "team");
  await actor.selectOptions(
    screen.getByLabelText("Destination mailboxes"),
    "box",
  );
  await actor.click(screen.getByRole("button", { name: "Queue mail route" }));
  expect(
    await screen.findByText(/Delivery changes require provider confirmation/),
  ).toBeInTheDocument();
  expect(mocks.api).toHaveBeenCalledWith(
    "/organizations/org/mail-routes",
    "PUT",
    {
      domainId: "domain",
      localPart: "team",
      kind: "alias",
      targets: ["box"],
      enabled: true,
    },
  );
});
