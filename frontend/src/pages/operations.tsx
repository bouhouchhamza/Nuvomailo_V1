import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth";
import { Empty, ErrorMessage, Status, useAction } from "../components";
import type { AuditEvent, Page, ProvisioningJob } from "../types";
export function Operations({ orgId }: { orgId: string }) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const [jobs, setJobs] = useState<Page<ProvisioningJob> | null>(null),
    [audit, setAudit] = useState<Page<AuditEvent> | null>(null);
  const [loading, setLoading] = useState(true);
  const base = `/organizations/${orgId}`;
  const load = useCallback(async () => {
    const [requests, events] = await Promise.all([
      api<Page<ProvisioningJob>>(`${base}/provisioning-requests?limit=25`),
      api<Page<AuditEvent>>(`${base}/audit-events?limit=25`),
    ]);
    setJobs(requests);
    setAudit(events);
  }, [api, base]);
  useEffect(() => {
    void run(load).finally(() => setLoading(false));
  }, [load]);
  return (
    <>
      <div className="section-heading">
        <h2>Operations & audit</h2>
        <button disabled={busy} onClick={() => void run(load)}>
          Refresh operations
        </button>
      </div>
      <p className="muted">
        Tenant-scoped provisioning requests and recorded administrative changes.
        Failed requests block later changes to the same mailbox until reviewed
        and retried.
      </p>
      <div className="notice">
        Mail infrastructure is not connected. Deferred requests are expected and
        cannot send or receive email.
      </div>
      <ErrorMessage message={error} />
      {loading ? (
        <p role="status">Loading operations…</p>
      ) : (
        <>
          <h3>Provisioning requests</h3>
          {!jobs?.items.length ? (
            <Empty>No provisioning requests yet.</Empty>
          ) : (
            <div className="table-wrap card">
              <table>
                <thead>
                  <tr>
                    <th>Mailbox / operation</th>
                    <th>State</th>
                    <th>Attempt / revision</th>
                    <th>Next eligible / error</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.items.map((job) => (
                    <tr key={job.id}>
                      <td>
                        {job.address}
                        <small>
                          {job.operation} → {job.desired_status}, {job.quota_mb}{" "}
                          MB
                        </small>
                      </td>
                      <td>
                        <Status
                          value={
                            job.state === "failed" ? "dead letter" : job.state
                          }
                        />
                      </td>
                      <td>
                        {job.attempts} / {job.max_attempts}
                        <small>Revision {job.revision}</small>
                      </td>
                      <td>
                        {new Date(job.available_at).toLocaleString()}
                        <small>{job.last_error_code ?? "—"}</small>
                      </td>
                      <td>
                        {job.state === "failed" ? (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await api(
                                  `${base}/provisioning-requests/${job.id}/retry`,
                                  "POST",
                                );
                                await load();
                              })
                            }
                          >
                            Retry request
                          </button>
                        ) : (
                          <small>
                            {job.state === "pending"
                              ? "Queued"
                              : job.state === "processing"
                                ? "Leased"
                                : "Recorded"}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {jobs.nextCursor && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = await api<Page<ProvisioningJob>>(
                        `${base}/provisioning-requests?limit=25&before=${jobs.nextCursor}`,
                      );
                      setJobs({
                        items: [...jobs.items, ...next.items],
                        nextCursor: next.nextCursor,
                      });
                    })
                  }
                >
                  Load more requests
                </button>
              )}
            </div>
          )}
          <h3>Audit history</h3>
          {!audit?.items.length ? (
            <Empty>No recorded changes yet.</Empty>
          ) : (
            <div className="table-wrap card">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Resource</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.items.map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.created_at).toLocaleString()}</td>
                      <td>{event.action}</td>
                      <td>{event.actor_user_id ?? "System worker"}</td>
                      <td>
                        <code>{event.resource_id ?? "—"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.nextCursor && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = await api<Page<AuditEvent>>(
                        `${base}/audit-events?limit=25&before=${audit.nextCursor}`,
                      );
                      setAudit({
                        items: [...audit.items, ...next.items],
                        nextCursor: next.nextCursor,
                      });
                    })
                  }
                >
                  Load more audit events
                </button>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
