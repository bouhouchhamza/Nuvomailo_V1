import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { ErrorMessage, useAction } from "../components";
import type { LoginResponse } from "../types";
export function AuthPage() {
  const { api, signIn, expired } = useAuth();
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  const { busy, error, run } = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (register) await api("/auth/register", "POST", { email, password });
      signIn(
        await api<LoginResponse>("/auth/login", "POST", {
          email,
          password,
          ...(factor ? { factor } : {}),
        }),
      );
      setPassword("");
      setFactor("");
    });
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <a className="brand" href="/">
          ✉ Nuvomailo
        </a>
        <span className="eyebrow">YOUR MAIL. YOUR CONTROL.</span>
        <h1>A considered home for your organization’s email.</h1>
        <p>
          Manage your team, verify your domains, and prepare your mailboxes from
          one workspace.
        </p>
        <div className="pilot-label">
          Development pilot · Mail infrastructure pending
        </div>
      </section>
      <section className="auth-panel">
        <form onSubmit={submit}>
          <span className="eyebrow">WELCOME TO YOUR WORKSPACE</span>
          <h2>{register ? "Create your account" : "Welcome back"}</h2>
          <p className="muted">
            {register
              ? "Start with an account, then create your organization."
              : "Sign in to manage your organizations."}
          </p>
          {expired && (
            <div role="status" className="notice">
              Your session expired. Please sign in again.
            </div>
          )}
          <ErrorMessage message={error} />
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={register ? 12 : 1}
              maxLength={128}
              required
            />
          </label>
          {register && (
            <small>
              Use at least 12 characters. Dashboard credentials are separate
              from mailbox credentials.
            </small>
          )}
          {!register && (
            <label>
              Authenticator or recovery code (if enabled)
              <input
                autoComplete="one-time-code"
                value={factor}
                onChange={(e) => setFactor(e.target.value)}
                maxLength={128}
              />
            </label>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? "Please wait…" : register ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="text-button full"
            disabled={busy}
            onClick={() => setRegister(!register)}
          >
            {register
              ? "Already have an account? Sign in"
              : "New here? Create an account"}
          </button>
          <small>
            Sessions renew securely and can survive page reloads. Dashboard and
            mailbox passwords remain separate.
          </small>
        </form>
        <IdentityRecovery />
      </section>
    </main>
  );
}
function IdentityRecovery() {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [mode, setMode] = useState<"forgot" | "reset" | "verify">("forgot"),
    [email, setEmail] = useState(""),
    [token, setToken] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (mode === "forgot") {
        const result = await api<{
          message: string;
          deliveryAvailable: boolean;
        }>("/auth/forgot-password", "POST", { email });
        setMessage(
          result.deliveryAvailable
            ? result.message
            : "Recovery delivery is unavailable in this environment.",
        );
      } else {
        await api(
          mode === "reset" ? "/auth/reset-password" : "/auth/verify-email",
          "POST",
          { token, ...(mode === "reset" ? { password } : {}) },
        );
        setMessage(
          mode === "reset"
            ? "Password changed. Sign in with your new password."
            : "Email verified. You can sign in.",
        );
        setToken("");
        setPassword("");
      }
    });
  }
  return (
    <details>
      <summary>Account recovery and email verification</summary>
      <form onSubmit={submit}>
        <label>
          Recovery action
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setMessage("");
              setToken("");
              setPassword("");
            }}
          >
            <option value="forgot">Request password reset</option>
            <option value="reset">Use password reset code</option>
            <option value="verify">Verify email with code</option>
          </select>
        </label>
        {mode === "forgot" ? (
          <label>
            Recovery email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
            />
          </label>
        ) : (
          <label>
            Single-use code
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              required
              maxLength={128}
            />
          </label>
        )}
        {mode === "reset" && (
          <label>
            Replacement password
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              maxLength={128}
            />
          </label>
        )}
        <button disabled={busy}>Continue recovery</button>
        <ErrorMessage message={error} />
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
