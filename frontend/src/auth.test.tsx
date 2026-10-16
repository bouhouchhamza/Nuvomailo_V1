import { it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./auth";
const data = {
  user: {
    id: "identity",
    email: "session@example.test",
    created_at: "2026-10-14",
  },
  accessToken: "fresh",
  expiresIn: 900,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function Harness() {
  const { user, booting, api, signOut } = useAuth();
  return (
    <>
      <p>{booting ? "restoring" : (user?.email ?? "signed out")}</p>
      <button onClick={() => void Promise.all([api("/one"), api("/two")])}>
        Load
      </button>
      <button onClick={signOut}>Logout</button>
    </>
  );
}
it("restores session from HttpOnly cookie boundary on mount without browser token storage", async () => {
  const fetcher = vi.fn(async () => json(data));
  vi.stubGlobal("fetch", fetcher);
  render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
  await screen.findByText(data.user.email);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/auth/refresh",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "X-Nuvomailo-CSRF": "1" }),
    }),
  );
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
it("coalesces concurrent renewal and retries authorized requests with new access token", async () => {
  let refreshes = 0;
  const retried: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/auth/refresh")
        return json({
          ...data,
          accessToken: ++refreshes === 1 ? "old" : "new",
        });
      if (
        (init?.headers as Record<string, string>).Authorization === "Bearer old"
      )
        return json({ error: "Expired" }, 401);
      retried.push(path);
      return json({ ok: true });
    }),
  );
  render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
  await screen.findByText(data.user.email);
  await userEvent.click(screen.getByText("Load"));
  await waitFor(() => expect(retried.sort()).toEqual(["/api/one", "/api/two"]));
  expect(refreshes).toBe(2);
});
it("revokes remotely before clearing state and retains session on logout transport failure", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path === "/api/auth/refresh"
        ? json(data)
        : fail
          ? json({ error: "Unavailable" }, 503)
          : new Response(null, { status: 204 }),
    ),
  );
  render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
  await screen.findByText(data.user.email);
  await userEvent.click(screen.getByText("Logout"));
  await screen.findByRole("alert");
  expect(screen.getByText(data.user.email)).toBeInTheDocument();
  fail = false;
  await userEvent.click(screen.getByText("Logout"));
  await screen.findByText("signed out");
});
