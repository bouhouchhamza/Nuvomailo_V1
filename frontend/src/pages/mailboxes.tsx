import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { ErrorMessage, Empty, Status, useAction } from "../components";
import type { Domain, Mailbox } from "../types";
export function Mailboxes({
  orgId,
  domains,
  mailboxes,
  canManage,
  isOwner = false,
  reload,
}: {
  orgId: string;
  domains: Domain[];
  mailboxes: Mailbox[];
  canManage: boolean;
  isOwner?: boolean;
  reload: () => Promise<void>;
}) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const verified = domains.filter((d) => d.verification_status === "verified");
  const [domainId, setDomainId] = useState(""),
    [localPart, setLocalPart] = useState(""),
    [quotaMb, setQuota] = useState(100);
  const [customQuota, setCustomQuota] = useState(false);
  const path = `/organizations/${orgId}/mailboxes`;
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(path, "POST", {
        domainId: domainId || verified[0]?.id,
        localPart,
        quotaMb,
      });
      setLocalPart("");
      await reload();
    });
  }
  return (
    <>
      <h2>Mailbox configuration</h2>
      <p className="muted">
        Manage desired addresses and quotas separately from confirmed
        mail-system state.
      </p>
      <div className="notice">
        Mail integration is pending Phase 6. These mailboxes cannot send or
        receive email. Configuration changes are queued and are not live.
      </div>
      <ErrorMessage message={error} />
      {isOwner && (
        <p>
          Retention reserves the address and quota, queues authentication
          suspension and preserves stored mail. Inbound delivery may continue.
          Restoration queues reactivation; no automatic deletion is scheduled.
        </p>
      )}
      {canManage &&
        (verified.length ? (
          <form className="card mailbox-form" onSubmit={submit}>
            <label>
              Mailbox name
              <input
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                placeholder="hello"
                pattern="[a-zA-Z0-9]+([._-][a-zA-Z0-9]+)*"
                maxLength={64}
                required
              />
            </label>
            <label>
              Domain
              <select
                value={domainId || verified[0]?.id}
                onChange={(e) => setDomainId(e.target.value)}
              >
                {verified.map((d) => (
                  <option key={d.id} value={d.id}>
                    @{d.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quota
              <select
                value={customQuota ? "custom" : quotaMb}
                onChange={(e) => {
                  setCustomQuota(e.target.value === "custom");
                  if (e.target.value !== "custom")
                    setQuota(Number(e.target.value));
                }}
              >
                <option value={100}>100 MB</option>
                <option value={200}>200 MB</option>
                <option value="custom">Custom quota (plan limits apply)</option>
              </select>
            </label>
            {customQuota && (
              <label>
                Custom quota in MiB
                <input
                  type="number"
                  min={1}
                  max={1048576}
                  step={1}
                  value={quotaMb}
                  onChange={(e) => setQuota(Number(e.target.value))}
                  required
                />
              </label>
            )}
            <button className="primary" disabled={busy}>
              Request mailbox
            </button>
          </form>
        ) : (
          <Empty>Verify a domain before creating a mailbox.</Empty>
        ))}
      {mailboxes.length ? (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Requested quota</th>
                <th>Status</th>
                <th>Desired / observed</th>
                {canManage && <th>Configuration</th>}
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((box) => (
                <tr key={box.id}>
                  <td>
                    <strong>{box.address}</strong>
                    {box.retained_at && (
                      <small>Retained — address and storage reserved</small>
                    )}
                  </td>
                  <td>{box.quota_mb} MB</td>
                  <td>
                    <Status value={box.provisioning_status} />
                  </td>
                  <td>
                    <div>
                      Desired: {box.desired_status ?? "active"} · revision{" "}
                      {box.desired_revision ?? 0}
                    </div>
                    <small>
                      Observed: {box.observed_status ?? "unknown"}
                      {box.observed_quota_mb
                        ? ` · ${box.observed_quota_mb} MB`
                        : ""}
                    </small>
                    <small>
                      {box.observed_at
                        ? `Checked ${new Date(box.observed_at).toLocaleString()}`
                        : "No infrastructure observation yet"}
                    </small>
                    {box.last_provisioning_error && (
                      <small>{box.last_provisioning_error}</small>
                    )}
                    <small>
                      {box.usageState === "unknown"
                        ? "Usage: unknown"
                        : `Usage: ${Math.ceil((box.usageBytes ?? 0) / 1024)} KiB · ${box.messageCount ?? 0} messages · ${box.usageState ?? "unknown"}`}
                    </small>
                    {box.usageObservedAt && (
                      <small>
                        Usage checked{" "}
                        {new Date(box.usageObservedAt).toLocaleString()}
                      </small>
                    )}
                    {box.usageLastErrorCode && (
                      <small>Usage refresh: {box.usageLastErrorCode}</small>
                    )}
                  </td>
                  {canManage && (
                    <td>
                      <div className="actions">
                        <button
                          disabled={busy || !!box.retained_at}
                          onClick={() =>
                            void run(async () => {
                              await api(`${path}/${box.id}`, "PATCH", {
                                quotaMb: box.quota_mb === 100 ? 200 : 100,
                              });
                              await reload();
                            })
                          }
                        >
                          Request {box.quota_mb === 100 ? 200 : 100} MB
                        </button>
                        <button
                          disabled={busy || !!box.retained_at}
                          onClick={() =>
                            void run(async () => {
                              await api(`${path}/${box.id}`, "PATCH", {
                                action:
                                  box.desired_status === "suspended"
                                    ? "resume"
                                    : "suspend",
                              });
                              await reload();
                            })
                          }
                        >
                          {box.desired_status === "suspended"
                            ? "Request resume"
                            : "Request suspension"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(`${path}/${box.id}/reconcile`, "POST");
                              await reload();
                            })
                          }
                        >
                          Request reconciliation
                        </button>
                        <button
                          disabled={busy || !box.usageRefreshAvailable}
                          onClick={() =>
                            void run(async () => {
                              await api(
                                `${path}/${box.id}/usage-refresh`,
                                "POST",
                              );
                              await reload();
                            })
                          }
                        >
                          Request usage refresh
                        </button>
                        {isOwner && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await api(
                                  `${path}/${box.id}/retention`,
                                  "POST",
                                  {
                                    action: box.retained_at
                                      ? "restore"
                                      : "retain",
                                  },
                                );
                                await reload();
                              })
                            }
                          >
                            {box.retained_at
                              ? "Request mailbox restoration"
                              : "Retain mailbox"}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No mailboxes configured yet.</Empty>
      )}
    </>
  );
}
