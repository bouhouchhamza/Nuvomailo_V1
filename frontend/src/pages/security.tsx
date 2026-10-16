import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
interface Session {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}
interface Event {
  id: string;
  action: string;
  created_at: string;
}
export function Security() {
  const { api, endSession } = useAuth();
  const { busy, error, run } = useAction();
  const [opened, setOpened] = useState(false),
    [rows, setRows] = useState<Session[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [enabled, setEnabled] = useState(false);
  const [password, setPassword] = useState(""),
    [nextPassword, setNextPassword] = useState(""),
    [factor, setFactor] = useState(""),
    [uri, setUri] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [message, setMessage] = useState("");
  async function load() {
    const [sessions, mfa, events] = await Promise.all([
      api<Session[]>("/auth/sessions"),
      api<{ enabled: boolean }>("/auth/mfa"),
      api<Event[]>("/auth/security-events"),
    ]);
    setRows(sessions);
    setEnabled(mfa.enabled);
    setEvents(events);
    setOpened(true);
  }
  function change(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api("/auth/change-password", "POST", {
        currentPassword: password,
        password: nextPassword,
      });
      setPassword("");
      setNextPassword("");
      endSession();
    });
  }
  return (
    <section className="card">
      <h2>Account security</h2>
      <button disabled={busy} onClick={() => void run(load)}>
        Security settings
      </button>
      <ErrorMessage message={error} />
      {message && <p role="status">{message}</p>}
      {opened && (
        <>
          <h3>Dashboard password</h3>
          <form onSubmit={change}>
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={128}
              />
            </label>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                value={nextPassword}
                onChange={(e) => setNextPassword(e.target.value)}
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <button disabled={busy}>Change password and revoke sessions</button>
          </form>
          <h3>Two-factor authentication</h3>
          <p>
            {enabled ? "Enabled" : "Not enabled"}. Enrollment and changes
            require your dashboard password. Save recovery codes offline.
          </p>
          <label>
            Confirmation password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={128}
            />
          </label>
          {!enabled && !uri && (
            <button
              disabled={busy || !password}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ uri: string }>(
                    "/auth/mfa/enroll",
                    "POST",
                    { password },
                  );
                  setUri(result.uri);
                  setPassword("");
                })
              }
            >
              Enroll authenticator
            </button>
          )}
          {uri && (
            <>
              <p>
                Add this private URI to your authenticator. It expires in five
                minutes. Do not share it.
              </p>
              <textarea
                aria-label="Private authenticator URI"
                readOnly
                value={uri}
              />
            </>
          )}
          <label>
            Authenticator or recovery code
            <input
              value={factor}
              onChange={(e) => setFactor(e.target.value)}
              autoComplete="one-time-code"
              maxLength={128}
            />
          </label>
          {uri && (
            <button
              disabled={busy || !factor}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ recoveryCodes: string[] }>(
                    "/auth/mfa/confirm",
                    "POST",
                    { factor },
                  );
                  setCodes(result.recoveryCodes);
                  setUri("");
                  setFactor("");
                  setEnabled(true);
                })
              }
            >
              Confirm authenticator
            </button>
          )}
          {codes.length > 0 && (
            <>
              <p>
                Recovery codes are shown once. Your previous sessions have been
                revoked.
              </p>
              <textarea
                aria-label="One-time recovery codes"
                readOnly
                value={codes.join("\n")}
              />
              <button
                onClick={() => {
                  setCodes([]);
                  endSession();
                }}
              >
                I saved my codes — sign in again
              </button>
            </>
          )}
          {enabled && !codes.length && (
            <div className="actions">
              <button
                disabled={busy || !factor}
                onClick={() =>
                  void run(async () => {
                    await api("/auth/mfa/step-up", "POST", { factor });
                    setFactor("");
                    setMessage("MFA confirmed for sensitive actions.");
                  })
                }
              >
                Confirm MFA for sensitive actions
              </button>
              <button
                disabled={busy || !password || !factor}
                onClick={() =>
                  void run(async () => {
                    await api("/auth/mfa/disable", "POST", {
                      password,
                      factor,
                    });
                    setPassword("");
                    setFactor("");
                    endSession();
                  })
                }
              >
                Disable MFA and revoke sessions
              </button>
            </div>
          )}
          <h3>Email verification</h3>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api("/auth/verification", "POST");
                setMessage(
                  "Verification requested. Use the instructions from your configured delivery channel.",
                );
              })
            }
          >
            Request verification
          </button>
          <h3>Sessions</h3>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api("/auth/revoke-all", "POST");
                endSession();
              })
            }
          >
            Revoke all sessions
          </button>
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                {new Date(row.created_at).toLocaleString()} —{" "}
                {row.revoked_at ? "revoked" : "active"}{" "}
                {!row.revoked_at && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/auth/sessions/${row.id}`, "DELETE");
                        await load();
                      })
                    }
                  >
                    Revoke session
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h3>Security activity</h3>
          <ul>
            {events.map((event) => (
              <li key={event.id}>
                {event.action} — {new Date(event.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
