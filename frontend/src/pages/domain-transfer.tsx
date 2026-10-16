import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
import type { Domain } from "../types";
export function DomainTransfer({
  orgId,
  domains,
  reload,
}: {
  orgId: string;
  domains: Domain[];
  reload: () => Promise<void>;
}) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [organizations, setOrganizations] = useState<
      { id: string; name: string; role: string }[]
    >([]),
    [domain, setDomain] = useState(""),
    [target, setTarget] = useState(""),
    [password, setPassword] = useState(""),
    [notice, setNotice] = useState("");
  const eligible = domains.filter(
    (row) =>
      row.mail_ever_activated === false &&
      row.status !== "retained" &&
      row.status !== "suspended",
  );
  return (
    <details className="card">
      <summary>Transfer an empty domain</summary>
      <p>
        Only empty domains with no mail activation history can move between
        organizations you own. Mail data is never moved by this action. Fresh
        DNS verification is required afterward.
      </p>
      <ErrorMessage message={error} />
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setOrganizations(
              (await api<typeof organizations>("/organizations")).filter(
                (org) => org.id !== orgId && org.role === "owner",
              ),
            );
          })
        }
      >
        Load organizations I own
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const secret = password;
          setPassword("");
          void run(async () => {
            if (
              !window.confirm(
                "Transfer this empty domain and invalidate its current verification proof?",
              )
            )
              return;
            await api(
              `/organizations/${orgId}/domains/${domain}/transfer`,
              "POST",
              { targetOrganizationId: target, dashboardPassword: secret },
            );
            setDomain("");
            setNotice(
              "Domain transferred. Verify it again in the target organization before requesting mailboxes.",
            );
            await reload();
          });
        }}
      >
        <label>
          Empty source domain
          <select
            required
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          >
            <option value="">Choose eligible domain</option>
            {eligible.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target organization
          <select
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose owned organization</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dashboard password to transfer domain
          <input
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button disabled={busy || !eligible.length}>
          Transfer empty domain
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
