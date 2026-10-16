import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
import { StaffPlans } from "./staff-plans";
import { SupportDiagnostics } from "./support-grants";
import { Incidents } from "./incidents";
interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  domains: number;
  mailboxes: number;
}
export function Platform() {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [role, setRole] = useState(""),
    [items, setItems] = useState<Organization[]>([]),
    [search, setSearch] = useState(""),
    [details, setDetails] = useState<unknown>(null),
    [queue, setQueue] = useState<
      | {
          id: string;
          state: string;
          operation: string;
          attempts: number;
          last_error_code: string | null;
        }[]
      | null
    >(null),
    [audit, setAudit] = useState<unknown>(null);
  const [health, setHealth] = useState<unknown>(null);
  async function load(before?: string) {
    const [access, rows] = await Promise.all([
      api<{ role: string }>("/platform/access"),
      api<Organization[]>(
        `/platform/organizations?search=${encodeURIComponent(search)}${before ? `&before=${before}` : ""}`,
      ),
    ]);
    setRole(access.role);
    setItems(rows);
  }
  return (
    <details className="card">
      <summary>Platform administration</summary>
      <p>
        Staff access is separate from organization ownership and requires
        verified identity and recent MFA. Confirm MFA in account security if
        needed.
      </p>
      <label>
        Organization search
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
        />
      </label>
      <button disabled={busy} onClick={() => void run(() => load())}>
        Open staff directory
      </button>
      <ErrorMessage message={error} />
      {role && (
        <>
          <p>Staff role: {role}</p>
          <SupportDiagnostics />
          <Incidents operator={role === "operator"} />
          <ul>
            {items.map((org) => (
              <li key={org.id}>
                <strong>{org.name}</strong> — {org.status} — {org.domains}{" "}
                domains / {org.mailboxes} mailboxes{" "}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setDetails(
                        await api(`/platform/organizations/${org.id}`),
                      ),
                    )
                  }
                >
                  Inspect organization
                </button>
                {role === "operator" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (
                          !window.confirm(
                            `Change ${org.name} control-plane status? Existing mail policy and stored messages are retained.`,
                          )
                        )
                          return;
                        await api(
                          `/platform/organizations/${org.id}/status`,
                          "PATCH",
                          {
                            status:
                              org.status === "active" ? "suspended" : "active",
                            reason: "owner-request",
                          },
                        );
                        await load();
                      })
                    }
                  >
                    {org.status === "active"
                      ? "Suspend control plane"
                      : "Resume control plane"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {items.length === 25 && (
            <button
              disabled={busy}
              onClick={() => void run(() => load(items.at(-1)!.id))}
            >
              Next organizations
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setQueue(
                  await api<NonNullable<typeof queue>>("/platform/queue"),
                ),
              )
            }
          >
            Inspect pending queue
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => setAudit(await api("/platform/audit")))
            }
          >
            Inspect platform audit
          </button>
          {details !== null && <pre>{JSON.stringify(details, null, 2)}</pre>}
          {queue !== null && (
            <ul>
              {queue.map((job) => (
                <li key={job.id}>
                  {job.operation} — {job.state} — attempts {job.attempts}{" "}
                  {job.last_error_code}
                  {role === "operator" && job.state === "failed" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (
                            !window.confirm(
                              "Retry this failed request after confirming its provider or configuration has recovered?",
                            )
                          )
                            return;
                          await api(`/platform/queue/${job.id}/retry`, "POST", {
                            reason: "provider-recovered",
                          });
                          setQueue(
                            await api<NonNullable<typeof queue>>(
                              "/platform/queue",
                            ),
                          );
                        })
                      }
                    >
                      Retry failed request {job.id}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <StaffPlans operator={role === "operator"} />
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setHealth(await api("/platform/health"));
              })
            }
          >
            Inspect queue health
          </button>
          {health !== null && <pre>{JSON.stringify(health, null, 2)}</pre>}
          {audit !== null && <pre>{JSON.stringify(audit, null, 2)}</pre>}
        </>
      )}
    </details>
  );
}
