import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { ErrorMessage, useAction } from "../components";
interface Plan {
  id: string;
  name: string;
  max_domains: number;
  max_mailboxes: number;
  max_quota_mb: number;
  storage_mb: string;
  monthly_minor: number;
  currency: string;
}
interface Overview {
  entitlements: Plan & { state: string | null; canExpand: boolean };
  invoices: {
    id: string;
    state: string;
    amount_minor: number;
    currency: string;
    created_at: string;
  }[];
  renewals: {
    id: string;
    plan_id: string;
    period: "monthly" | "yearly";
    prior_period_end: string;
    amount_minor: number;
    currency: string;
    state:
      | "pending"
      | "processing"
      | "succeeded"
      | "failed"
      | "superseded"
      | "uncertain";
    attempts: number;
    last_error_code: string | null;
  }[];
  providerAvailable: boolean;
  usageMetering: {
    rollupState: "unknown" | "fresh" | "stale";
    coverageComplete: boolean;
    billingEligible: boolean;
    observedUsageBytes?: string;
    observedMessageCount?: string;
    mailboxCount?: number;
    freshMailboxCount?: number;
    staleMailboxCount?: number;
    unknownMailboxCount?: number;
  };
}
export function Billing({
  orgId,
  isOwner,
}: {
  orgId: string;
  isOwner: boolean;
}) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [data, setData] = useState<Overview | null>(null),
    [plans, setPlans] = useState<Plan[]>([]),
    [plan, setPlan] = useState(""),
    [period, setPeriod] = useState("monthly"),
    [message, setMessage] = useState("");
  async function load() {
    const [overview, catalog] = await Promise.all([
      api<Overview>(`/billing/${orgId}`),
      api<{ plans: Plan[] }>("/billing/plans"),
    ]);
    setData(overview);
    setPlans(catalog.plans);
    setPlan(overview.entitlements.id);
  }
  useEffect(() => {
    void run(load);
  }, [api, orgId]);
  return (
    <section className="card">
      <h2>Billing and entitlements</h2>
      <p>
        This environment uses a local sandbox catalog. No real payments are
        collected.
      </p>
      <ErrorMessage message={error} />
      {message && <p role="status">{message}</p>}
      {data ? (
        <>
          <p>
            {data.entitlements.name} —{" "}
            {data.entitlements.state ?? "development default"}
          </p>
          <dl>
            <dt>Mailboxes</dt>
            <dd>{data.entitlements.max_mailboxes}</dd>
            <dt>Domains</dt>
            <dd>{data.entitlements.max_domains}</dd>
            <dt>Maximum mailbox quota</dt>
            <dd>{data.entitlements.max_quota_mb} MiB</dd>
            <dt>Configured storage allowance</dt>
            <dd>
              {data.entitlements.storage_mb} MiB
            </dd>
          </dl>
          <h3>Observed mail usage</h3>
          {!data.usageMetering ||
          data.usageMetering.rollupState === "unknown" ? (
            <p>Awaiting mailbox usage observations.</p>
          ) : (
            <p>
              {data.usageMetering.observedUsageBytes} bytes across{" "}
              {data.usageMetering.mailboxCount} mailboxes; coverage is{" "}
              {data.usageMetering.coverageComplete ? "complete" : "incomplete"}.
            </p>
          )}
          <p>
            Observed usage is informational and cannot create a charge until a
            pricing and renewal policy is approved.
          </p>
          <h3>Renewal history</h3>
          {data.renewals?.length ? (
            <ul>
              {data.renewals.map((renewal) => (
                <li key={renewal.id}>
                  {renewal.state} — {renewal.period} —{" "}
                  {(renewal.amount_minor / 100).toFixed(2)} {renewal.currency}
                  {renewal.state === "uncertain"
                    ? " — requires operator reconciliation; it will not retry automatically"
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>No renewal attempts.</p>
          )}
          {!data.entitlements.canExpand && (
            <p>
              New resources are restricted. Existing mail and configurations are
              retained.
            </p>
          )}
          {isOwner && (
            <>
              <label>
                Plan
                <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Billing period
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </label>
              <button
                disabled={busy || !data.providerAvailable}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ id: string }>(
                      `/billing/${orgId}/checkout`,
                      "POST",
                      { planId: plan, period },
                    );
                    setMessage(
                      `Sandbox checkout ${result.id} created. No charge was made; a signed local provider event is required.`,
                    );
                  })
                }
              >
                Create sandbox checkout
              </button>
              {!data.providerAvailable && (
                <p>
                  Checkout is unavailable until a test payment provider is
                  configured.
                </p>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      !window.confirm(
                        "Cancel renewal at the end of the current period? Mail will be retained.",
                      )
                    )
                      return;
                    await api(`/billing/${orgId}/cancel`, "POST");
                    setMessage(
                      "Cancellation scheduled. Existing mail is retained.",
                    );
                    await load();
                  })
                }
              >
                Cancel renewal
              </button>
            </>
          )}
          <h3>Sandbox invoice history</h3>
          {data.invoices.length ? (
            <ul>
              {data.invoices.map((invoice) => (
                <li key={invoice.id}>
                  {invoice.state} — {(invoice.amount_minor / 100).toFixed(2)}{" "}
                  {invoice.currency} —{" "}
                  {new Date(invoice.created_at).toLocaleDateString()}
                </li>
              ))}
            </ul>
          ) : (
            <p>No invoices.</p>
          )}
        </>
      ) : (
        !error && <p role="status">Loading billing…</p>
      )}
    </section>
  );
}
