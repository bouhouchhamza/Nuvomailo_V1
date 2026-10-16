import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Incidents } from "./pages/incidents";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./auth", () => ({ useAuth: () => mocks }));
beforeEach(() => mocks.api.mockReset());
it("viewer can inspect incidents without transition controls or notification claims", async () => {
  mocks.api.mockResolvedValue({
    notificationDelivery: "local-synthetic-available",
    alertQueue: [{ state: "pending", events: 1 }],
    incidents: [
      {
        id: "one",
        component: "backup",
        symptom: "recovery-failed",
        severity: "critical",
        state: "open",
        version: 1,
      },
    ],
  });
  render(<Incidents operator={false} />);
  await userEvent.click(screen.getByText("Review incidents"));
  expect(
    await screen.findByText(/backup: recovery-failed/),
  ).toBeInTheDocument();
  expect(screen.queryByText("Open incident")).not.toBeInTheDocument();
  expect(screen.queryByText("Acknowledge incident")).not.toBeInTheDocument();
  expect(
    screen.getByText(/Durable local synthetic alert delivery is available/),
  ).toBeInTheDocument();
  expect(screen.getByText(/Alert queue: pending 1/)).toBeInTheDocument();
});
it("operator acknowledgements carry the observed version and reload after mutation", async () => {
  let state = "open",
    version = 4;
  mocks.api.mockImplementation(async (_path: string, method?: string) => {
    if (method === "PATCH") {
      state = "acknowledged";
      version++;
      return {};
    }
    return {
      notificationDelivery: "local-synthetic-available",
      alertQueue: [],
      incidents: [
        {
          id: "one",
          component: "backup",
          symptom: "recovery-failed",
          severity: "critical",
          state,
          version,
        },
      ],
    };
  });
  render(<Incidents operator />);
  const actor = userEvent.setup();
  await actor.click(screen.getByText("Review incidents"));
  await actor.click(await screen.findByText("Acknowledge incident"));
  expect(mocks.api).toHaveBeenCalledWith("/platform/incidents/one", "PATCH", {
    version: 4,
    action: "acknowledge",
  });
  expect(await screen.findByText("Resolve incident")).toBeInTheDocument();
});
