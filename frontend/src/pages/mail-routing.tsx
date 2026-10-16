import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
import type { Domain, Mailbox } from "../types";
type Route = {
  id: string;
  domain_id: string;
  local_part: string;
  kind: "alias" | "forward";
  targets: string[];
  enabled: boolean;
  address: string;
};
export function MailRouting({
  orgId,
  domains,
  mailboxes,
  canManage,
}: {
  orgId: string;
  domains: Domain[];
  mailboxes: Mailbox[];
  canManage: boolean;
}) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [rows, setRows] = useState<Route[]>([]),
    [domain, setDomain] = useState(""),
    [local, setLocal] = useState(""),
    [kind, setKind] = useState<"alias" | "forward">("alias"),
    [targets, setTargets] = useState<string[]>([]),
    [notice, setNotice] = useState("");
  async function load() {
    setRows(await api<Route[]>(`/organizations/${orgId}/mail-routes`));
  }
  async function save(enabled = true, route?: Route) {
    const result = await api<{ generation: number }>(
      `/organizations/${orgId}/mail-routes`,
      "PUT",
      {
        domainId: route?.domain_id ?? domain,
        localPart: route?.local_part ?? local,
        kind: route?.kind ?? kind,
        targets: route?.targets ?? targets,
        enabled,
      },
    );
    setNotice(
      `Routing generation ${result.generation} queued. Delivery changes require provider confirmation. External forwarding is disabled.`,
    );
    await load();
  }
  return (
    <section className="card">
      <h2>Aliases and internal forwarding</h2>
      <p>
        Routes deliver only to this organization's mailboxes. Alias chains and
        external destinations are not enabled. Disabled addresses remain
        reserved.
      </p>
      <ErrorMessage message={error} />
      <button disabled={busy} onClick={() => void run(load)}>
        Load mail routes
      </button>
      {notice && <p role="status">{notice}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {row.address} — {row.kind} —{" "}
            {row.enabled ? "Enabled intent" : "Disabled intent"}
            {canManage && (
              <>
                <button
                  disabled={busy}
                  onClick={() => {
                    setDomain(row.domain_id);
                    setLocal(row.local_part);
                    setKind(row.kind);
                    setTargets(row.targets);
                  }}
                >
                  Edit {row.address}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void run(() => save(!row.enabled, row))}
                >
                  {row.enabled ? "Disable" : "Enable"} {row.address}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => save());
          }}
        >
          <label>
            Source domain
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
            >
              <option value="">Choose verified domain</option>
              {domains
                .filter((item) => item.verification_status === "verified")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Source address local part
            <input
              required
              pattern="[a-z0-9]+([._-][a-z0-9]+)*"
              maxLength={64}
              value={local}
              onChange={(e) => setLocal(e.target.value)}
            />
          </label>
          <label>
            Routing type
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "alias" | "forward")}
            >
              <option value="alias">Alias to one mailbox</option>
              <option value="forward">Forward to internal mailboxes</option>
            </select>
          </label>
          <label>
            Destination mailboxes
            <select
              required
              multiple
              value={targets}
              onChange={(e) =>
                setTargets(
                  Array.from(
                    e.target.selectedOptions,
                    (option) => option.value,
                  ),
                )
              }
            >
              {mailboxes
                .filter((item) => item.desired_status === "active")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.address}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={busy}>Queue mail route</button>
        </form>
      )}
    </section>
  );
}
