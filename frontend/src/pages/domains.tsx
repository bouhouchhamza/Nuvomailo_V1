import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { ErrorMessage, Empty, Status, useAction } from "../components";
import type { Domain } from "../types";
import { DomainTransfer } from "./domain-transfer";
export function Domains({
  orgId,
  domains,
  canManage,
  reload,
  isOwner = false,
}: {
  orgId: string;
  domains: Domain[];
  canManage: boolean;
  reload: () => Promise<void>;
  isOwner?: boolean;
}) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown>>({});
  const [releaseId, setReleaseId] = useState(""),
    [confirmName, setConfirmName] = useState(""),
    [password, setPassword] = useState(""),
    [reason, setReason] = useState<"owner-no-longer-controls" | "test-claim">(
      "owner-no-longer-controls",
    );
  const path = `/organizations/${orgId}/domains`;
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(path, "POST", { name });
      setName("");
      await reload();
    });
  }
  return (
    <>
      {isOwner && (
        <DomainTransfer orgId={orgId} domains={domains} reload={reload} />
      )}
      <div className="section-heading">
        <div>
          <h2>Your domains</h2>
          <p className="muted">
            Verify ownership before configuring mailboxes.
          </p>
        </div>
      </div>
      <ErrorMessage message={error} />
      {canManage && (
        <form className="inline-form card" onSubmit={submit}>
          <label>
            Domain name
            <input
              placeholder="example.org"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={253}
            />
          </label>
          <button className="primary" disabled={busy}>
            Add domain
          </button>
        </form>
      )}
      {!domains.length ? (
        <Empty>
          No domains yet. Add a domain your organization owns to begin.
        </Empty>
      ) : (
        <div className="card-list">
          {domains.map((domain) => (
            <article className="card" key={domain.id}>
              <div className="card-heading">
                <h3>{domain.name}</h3>
                <Status value={domain.verification_status} />
              </div>
              {domain.verification_status !== "verified" ? (
                <>
                  <p>
                    Add this TXT record through your DNS provider, then check
                    ownership here. DNS propagation may take time.
                  </p>
                  <dl className="dns-details">
                    <dt>Type</dt>
                    <dd>TXT</dd>
                    <dt>Name</dt>
                    <dd>
                      <code>{domain.dnsChallenge.name}</code>
                    </dd>
                    <dt>Value</dt>
                    <dd>
                      <code>{domain.dnsChallenge.value}</code>
                    </dd>
                  </dl>
                  <p className="muted">
                    Challenge expires{" "}
                    {new Date(
                      domain.verification_expires_at,
                    ).toLocaleDateString()}
                    . Attempts: {domain.verification_attempts}. Checks are
                    limited to once a minute.
                  </p>
                  {canManage && (
                    <div className="actions">
                      <button
                        disabled={busy}
                        className="primary"
                        onClick={() =>
                          void run(async () => {
                            await api(`${path}/${domain.id}/verify`, "POST");
                            await reload();
                          })
                        }
                      >
                        Check DNS ownership
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(`${path}/${domain.id}/challenge`, "POST");
                            await reload();
                          })
                        }
                      >
                        Renew challenge
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p>
                    Ownership confirmed. Revalidation:{" "}
                    {domain.revalidation_state ?? "due"}.
                  </p>
                  {domain.revalidation_grace_expires_at && (
                    <p className="notice">
                      Ownership proof is missing. Grace ends{" "}
                      {new Date(
                        domain.revalidation_grace_expires_at,
                      ).toLocaleString()}
                      ; mail traffic is not changed by this warning.
                    </p>
                  )}
                  {canManage && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(`${path}/${domain.id}/revalidate`, "POST");
                          await reload();
                        })
                      }
                    >
                      Revalidate DNS ownership
                    </button>
                  )}
                </>
              )}
              <div className="notice">
                Mail delivery is not configured. Ownership verification does not
                set up MX, SPF, DKIM, DMARC, SMTP or IMAP.
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api(`${path}/${domain.id}/health`);
                    setDiagnostics((current) => ({
                      ...current,
                      [domain.id]: result,
                    }));
                  })
                }
              >
                Check DNS health
              </button>
              {diagnostics[domain.id] !== undefined && (
                <details open>
                  <summary>DNS diagnostics</summary>
                  <pre>{JSON.stringify(diagnostics[domain.id], null, 2)}</pre>
                  <p>Observed DNS records do not prove live mail readiness.</p>
                </details>
              )}
              {isOwner && (
                <div className="actions">
                  {(["suspend", "resume", "retain", "reverify"] as const).map(
                    (action) => (
                      <button
                        key={action}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            if (
                              !window.confirm(
                                `${action} domain configuration? Stored mail is retained; this does not itself change mail traffic policy.`,
                              )
                            )
                              return;
                            await api(
                              `${path}/${domain.id}/lifecycle`,
                              "POST",
                              { action },
                            );
                            await reload();
                          })
                        }
                      >
                        {action} configuration
                      </button>
                    ),
                  )}
                </div>
              )}
              {isOwner &&
                domain.mail_ever_activated === false &&
                (releaseId === domain.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const supplied = password;
                      setPassword("");
                      void run(async () => {
                        await api(`${path}/${domain.id}/release`, "POST", {
                          confirmName,
                          dashboardPassword: supplied,
                          reason,
                        });
                        setReleaseId("");
                        setConfirmName("");
                        await reload();
                      });
                    }}
                  >
                    <p>
                      Release is permanent for this organization and makes this
                      empty, never-activated name reusable. It does not change
                      DNS.
                    </p>
                    <label>
                      Confirm domain name
                      <input
                        required
                        value={confirmName}
                        onChange={(event) => setConfirmName(event.target.value)}
                        maxLength={253}
                      />
                    </label>
                    <label>
                      Dashboard password
                      <input
                        required
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        maxLength={128}
                      />
                    </label>
                    <label>
                      Reason
                      <select
                        value={reason}
                        onChange={(event) =>
                          setReason(event.target.value as typeof reason)
                        }
                      >
                        <option value="owner-no-longer-controls">
                          Owner no longer controls domain
                        </option>
                        <option value="test-claim">Synthetic/test claim</option>
                      </select>
                    </label>
                    <button disabled={busy}>Release empty domain</button>
                    <button
                      type="button"
                      onClick={() => {
                        setReleaseId("");
                        setPassword("");
                      }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setReleaseId(domain.id);
                      setConfirmName("");
                      setPassword("");
                    }}
                  >
                    Prepare domain release
                  </button>
                ))}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
