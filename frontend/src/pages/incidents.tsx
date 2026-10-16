import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
type Incident = {
  id: string;
  component: string;
  symptom: string;
  severity: string;
  state: string;
  version: number;
};
export function Incidents({ operator }: { operator: boolean }) {
  const { api } = useAuth(),
    { busy, error, run } = useAction(),
    [rows, setRows] = useState<Incident[]>([]),
    [component, setComponent] = useState("control-plane"),
    [symptom, setSymptom] = useState("unavailable"),
    [severity, setSeverity] = useState("warning"),
    [delivery, setDelivery] = useState("unconfigured"),
    [alertQueue, setAlertQueue] = useState<{ state: string; events: number }[]>(
      [],
    );
  const load = async () => {
    const result = await api<{
      incidents: Incident[];
      notificationDelivery: string;
      alertQueue: { state: string; events: number }[];
    }>("/platform/incidents");
    setRows(result.incidents);
    setDelivery(result.notificationDelivery);
    setAlertQueue(result.alertQueue ?? []);
  };
  return (
    <section>
      <h3>Incident register</h3>
      <p>
        {delivery === "local-synthetic-available"
          ? "Durable local synthetic alert delivery is available; external destinations are not configured."
          : "External alert delivery is not configured."}{" "}
        Resolving an incident records an operator decision and does not certify
        service recovery.
      </p>
      <button disabled={busy} onClick={() => void run(load)}>
        Review incidents
      </button>
      {operator && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/platform/incidents", "POST", {
                component,
                symptom,
                severity,
              });
              await load();
            });
          }}
        >
          <label>
            Affected component
            <select
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              {["control-plane", "mail-plane", "backup", "payments"].map(
                (x) => (
                  <option key={x}>{x}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Observed symptom
            <select
              value={symptom}
              onChange={(e) => setSymptom(e.target.value)}
            >
              {[
                "unavailable",
                "queue-delayed",
                "recovery-failed",
                "integrity-review",
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option>warning</option>
              <option>critical</option>
            </select>
          </label>
          <button disabled={busy}>Open incident</button>
        </form>
      )}
      <ErrorMessage message={error} />
      {alertQueue.length > 0 && (
        <p>
          Alert queue:{" "}
          {alertQueue.map((row) => `${row.state} ${row.events}`).join(", ")}
        </p>
      )}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {row.component}: {row.symptom} — {row.severity} — {row.state}
            {operator && row.state !== "resolved" && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/platform/incidents/${row.id}`, "PATCH", {
                      version: row.version,
                      action: row.state === "open" ? "acknowledge" : "resolve",
                    });
                    await load();
                  })
                }
              >
                {row.state === "open"
                  ? "Acknowledge incident"
                  : "Resolve incident"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
