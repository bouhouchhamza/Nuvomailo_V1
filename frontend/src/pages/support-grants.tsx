import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
type Grant = {
  id: string;
  staff_user_id: string;
  expires_at: string;
  revoked_at: string | null;
};
export function SupportGrants({ orgId }: { orgId: string }) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [rows, setRows] = useState<Grant[]>([]),
    [staff, setStaff] = useState(""),
    [minutes, setMinutes] = useState(15),
    [password, setPassword] = useState("");
  const path = `/organizations/${orgId}/support-grants`;
  const load = async () => setRows(await api<Grant[]>(path));
  return (
    <section className="card">
      <h2>Temporary support access</h2>
      <p>
        Allow a named support agent to read diagnostic counts for up to one
        hour. Message contents, credentials and member identities are excluded.
        You can revoke access at any time.
      </p>
      <button disabled={busy} onClick={() => void run(load)}>
        Review support grants
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const supplied = password;
          setPassword("");
          void run(async () => {
            await api(path, "POST", {
              staffUserId: staff,
              minutes,
              dashboardPassword: supplied,
            });
            await load();
          });
        }}
      >
        <label>
          Support agent ID
          <input
            required
            value={staff}
            onChange={(e) => setStaff(e.target.value)}
            maxLength={36}
          />
        </label>
        <label>
          Access duration
          <select
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
          </select>
        </label>
        <label>
          Dashboard password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={128}
          />
        </label>
        <button disabled={busy}>Grant diagnostic access</button>
      </form>
      <ErrorMessage message={error} />
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            Grant {row.id} — agent {row.staff_user_id} — expires{" "}
            {new Date(row.expires_at).toLocaleString()}{" "}
            {row.revoked_at ? (
              "Revoked"
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`${path}/${row.id}`, "DELETE");
                    await load();
                  })
                }
              >
                Revoke grant
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function SupportDiagnostics() {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [id, setId] = useState(""),
    [data, setData] = useState<unknown>(null);
  return (
    <section>
      <h3>Owner-authorized diagnostics</h3>
      <label>
        Support grant ID
        <input
          value={id}
          maxLength={36}
          onChange={(e) => {
            setId(e.target.value);
            setData(null);
          }}
        />
      </label>
      <button
        disabled={busy || !id}
        onClick={() => {
          setData(null);
          void run(async () =>
            setData(await api(`/platform/support/${encodeURIComponent(id)}`)),
          );
        }}
      >
        Read authorized diagnostics
      </button>
      <ErrorMessage message={error} />
      {data !== null && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </section>
  );
}
