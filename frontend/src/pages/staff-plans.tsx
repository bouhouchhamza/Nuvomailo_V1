import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
const limits = [
  ["monthlyMinor", "monthly_minor", "Monthly price (minor currency units)"],
  ["yearlyMinor", "yearly_minor", "Yearly price (minor currency units)"],
  ["maxDomains", "max_domains", "Maximum domains"],
  ["maxMailboxes", "max_mailboxes", "Maximum mailboxes"],
  ["maxMembers", "max_members", "Maximum members"],
  ["maxQuotaMb", "max_quota_mb", "Maximum mailbox quota (MiB)"],
  ["storageMb", "storage_mb", "Total configured storage (MiB)"],
  [
    "maxMailboxesPerDomain",
    "max_mailboxes_per_domain",
    "Maximum mailboxes per domain",
  ],
] as const;
type Plan = Record<string, string | number | boolean> & {
  id: string;
  name: string;
  currency: string;
  active: boolean;
};
export function StaffPlans({ operator }: { operator: boolean }) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [plans, setPlans] = useState<Plan[]>([]),
    [id, setId] = useState(""),
    [name, setName] = useState(""),
    [currency, setCurrency] = useState("USD"),
    [active, setActive] = useState(true),
    [numbers, setNumbers] = useState<Record<string, number>>({
      monthlyMinor: 0,
      yearlyMinor: 0,
      maxDomains: 1,
      maxMailboxes: 1,
      maxMembers: 1,
      maxQuotaMb: 100,
      storageMb: 100,
      maxMailboxesPerDomain: 1,
    }),
    [notice, setNotice] = useState("");
  async function load() {
    setPlans(await api<Plan[]>("/platform/plans"));
  }
  function select(plan: Plan) {
    setId(plan.id);
    setName(plan.name);
    setCurrency(plan.currency);
    setActive(plan.active);
    setNumbers(
      Object.fromEntries(
        limits.map(([key, column]) => [key, Number(plan[column])]),
      ),
    );
    setNotice("");
  }
  return (
    <details>
      <summary>Plan catalog</summary>
      <ErrorMessage message={error} />
      <button disabled={busy} onClick={() => void run(load)}>
        Load staff plans
      </button>
      <ul>
        {plans.map((plan) => (
          <li key={plan.id}>
            {plan.name} ({plan.id}) — {plan.active ? "Available" : "Inactive"}
            {operator && (
              <button disabled={busy} onClick={() => select(plan)}>
                Edit {plan.name}
              </button>
            )}
          </li>
        ))}
      </ul>
      {operator && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (
                !window.confirm(
                  "Save a new catalog version? Existing subscription limits and issued quotes stay frozen. New checkouts use the new version.",
                )
              )
                return;
              await api(`/platform/plans/${encodeURIComponent(id)}`, "PUT", {
                name,
                currency,
                active,
                ...numbers,
              });
              setNotice(
                "Catalog entry saved. No real payments were processed.",
              );
              await load();
            });
          }}
        >
          <p>
            For a new offering, enter a new plan identifier. Existing
            subscribers keep their captured limits until an explicit new
            checkout. Deactivating a plan hides it from new checkouts.
          </p>
          <label>
            Plan identifier
            <input
              required
              pattern="[a-z0-9-]{3,40}"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label>
            Plan name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Currency
            <input
              required
              pattern="[A-Z]{3}"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </label>
          {limits.map(([key, , label]) => (
            <label key={key}>
              {label}
              <input
                required
                type="number"
                min={key.endsWith("Minor") ? 0 : 1}
                step={1}
                value={numbers[key]}
                onChange={(e) =>
                  setNumbers({ ...numbers, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Available for new checkouts
          </label>
          <button disabled={busy}>Save plan catalog entry</button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
