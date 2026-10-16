import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
export function MailboxCredentials({
  mailboxes,
}: {
  mailboxes: { id: string; address: string; permission: string }[];
}) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [available, setAvailable] = useState(false),
    [checked, setChecked] = useState(false),
    [box, setBox] = useState(""),
    [purpose, setPurpose] = useState("setup"),
    [dashboard, setDashboard] = useState(""),
    [token, setToken] = useState(""),
    [password, setPassword] = useState(""),
    [notice, setNotice] = useState(""),
    [requestId, setRequestId] = useState("");
  return (
    <details>
      <summary>Mailbox password setup and rotation</summary>
      <p>
        Mailbox passwords are separate from dashboard passwords. Setup grants
        are authenticated, expire after15 minutes and can be used once.
      </p>
      <ErrorMessage message={error} />
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const status = await api<{
              configured: boolean;
              deliveryAvailable: boolean;
            }>("/mailbox-credentials");
            setAvailable(status.configured && status.deliveryAvailable);
            setChecked(true);
          })
        }
      >
        Check password setup availability
      </button>
      {checked && !available && (
        <p>
          Password setup delivery is not configured. No live credentials can be
          provisioned.
        </p>
      )}
      {available && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const secret = dashboard;
              setDashboard("");
              void run(async () => {
                await api(`/mailbox-credentials/${box}/grants`, "POST", {
                  purpose,
                  dashboardPassword: secret,
                });
                setNotice(
                  "Expiring grant delivered through the configured private setup channel.",
                );
              });
            }}
          >
            <label>
              Mailbox
              <select
                value={box}
                onChange={(e) => setBox(e.target.value)}
                required
              >
                <option value="">Choose mailbox</option>
                {mailboxes
                  .filter((row) => row.permission === "write")
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.address}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Credential action
              <select
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              >
                <option value="setup">First setup</option>
                <option value="reset">Reset forgotten password</option>
                <option value="rotate">Rotate password</option>
              </select>
            </label>
            <label>
              Dashboard password for confirmation
              <input
                type="password"
                autoComplete="current-password"
                value={dashboard}
                onChange={(e) => setDashboard(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>Request single-use grant</button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const grant = token,
                secret = password;
              setToken("");
              setPassword("");
              void run(async () => {
                const result = await api<{
                  requestId: string;
                  generation: number;
                }>("/mailbox-credentials/consume", "POST", {
                  token: grant,
                  purpose,
                  password: secret,
                });
                setRequestId(result.requestId);
                setNotice(
                  `Password generation ${result.generation} queued. It is not active until application is confirmed.`,
                );
              });
            }}
          >
            <label>
              Setup grant
              <input
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </label>
            <label>
              New separate mailbox password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>Consume grant and queue password</button>
          </form>
        </>
      )}
      {requestId && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api<{ state: string; generation: number }>(
                `/mailbox-credentials/requests/${requestId}`,
              );
              setNotice(
                `Password generation ${result.generation}: ${result.state}.`,
              );
            })
          }
        >
          Check credential application
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
