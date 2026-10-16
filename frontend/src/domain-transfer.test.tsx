import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DomainTransfer } from "./pages/domain-transfer";
import type { Domain } from "./types";
vi.mock("./auth", () => ({ useAuth: () => ({ api: vi.fn() }) }));
it("refuses to offer transfers for activated or unknown-custody domains", () => {
  render(
    <DomainTransfer
      orgId="org"
      domains={
        [
          {
            id: "activated",
            name: "activated.example.test",
            mail_ever_activated: true,
          },
          { id: "unknown", name: "unknown.example.test" },
        ] as Domain[]
      }
      reload={async () => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Transfer empty domain" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("option", { name: "activated.example.test" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "unknown.example.test" }),
  ).not.toBeInTheDocument();
});
