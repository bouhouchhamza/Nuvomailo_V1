import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MailboxCredentials } from "./pages/mailbox-credentials";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => {
  mocks.api.mockReset();
});
it("unconfigured credential delivery exposes no secret forms", async () => {
  mocks.api.mockResolvedValue({ configured: false, deliveryAvailable: false });
  render(<MailboxCredentials mailboxes={[]} />);
  await userEvent.click(screen.getByText("Check password setup availability"));
  expect(
    await screen.findByText(/No live credentials can be provisioned/),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("New separate mailbox password"),
  ).not.toBeInTheDocument();
});
it("single-use consumption clears grant/password and reports queued state without claiming activation", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path === "/mailbox-credentials"
      ? { configured: true, deliveryAvailable: true }
      : path === "/mailbox-credentials/consume"
        ? { requestId: "synthetic", generation: 2 }
        : { state: "applied", generation: 2 },
  );
  render(
    <MailboxCredentials
      mailboxes={[
        {
          id: "box",
          address: "credential@tenant-a.lab.invalid",
          permission: "write",
        },
      ]}
    />,
  );
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Check password setup availability"));
  await actor.type(
    await screen.findByLabelText("Setup grant"),
    "synthetic-grant",
  );
  await actor.type(
    screen.getByLabelText("New separate mailbox password"),
    "SyntheticMailboxOnly123!",
  );
  await actor.click(
    screen.getByRole("button", { name: "Consume grant and queue password" }),
  );
  expect(
    await screen.findByText(/not active until application is confirmed/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Setup grant")).toHaveValue("");
  expect(screen.getByLabelText("New separate mailbox password")).toHaveValue(
    "",
  );
  await actor.click(screen.getByText("Check credential application"));
  expect(
    await screen.findByText("Password generation 2: applied."),
  ).toBeInTheDocument();
});
