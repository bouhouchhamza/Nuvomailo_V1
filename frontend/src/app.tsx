import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AuthProvider, useAuth } from "./auth";
import { AuthPage } from "./pages/auth-page";
import { Domains } from "./pages/domains";
import { Mailboxes } from "./pages/mailboxes";
import { Members } from "./pages/members";
import { Operations } from "./pages/operations";
import { Security } from "./pages/security";
import { Invitations } from "./pages/invitations";
import { SupportGrants } from "./pages/support-grants";
import { Billing } from "./pages/billing";
import { Platform } from "./pages/platform";
import { Webmail } from "./pages/webmail";
import { MailRouting } from "./pages/mail-routing";
import { ErrorMessage, Empty, useAction } from "./components";
import type { Domain, Mailbox, Member, Organization, User } from "./types";

type Tab =
  | "overview"
  | "domains"
  | "mailboxes"
  | "members"
  | "account"
  | "operations"
  | "billing"
  | "webmail"
  | "routing";
function Workspace({
  organization,
  onRename,
}: {
  organization: Organization;
  onRename: () => Promise<void>;
}) {
  const { api, user } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<{
    domains: Domain[];
    mailboxes: Mailbox[];
    members: Member[];
  } | null>(null);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const [name, setName] = useState(organization.name);
  const { busy, error, run } = useAction();
  const canManage = organization.role !== "member";
  const reload = useCallback(async () => {
    const base = `/organizations/${organization.id}`;
    const [domains, mailboxes, members] = await Promise.all([
      api<Domain[]>(`${base}/domains`),
      api<Mailbox[]>(`${base}/mailboxes`),
      api<Member[]>(`${base}/members`),
    ]);
    setData({ domains, mailboxes, members });
  }, [api, organization.id]);
  useEffect(() => {
    let active = true;
    const base = `/organizations/${organization.id}`;
    setLoading(true);
    setLoadError("");
    void Promise.all([
      api<Domain[]>(`${base}/domains`),
      api<Mailbox[]>(`${base}/mailboxes`),
      api<Member[]>(`${base}/members`),
    ])
      .then(([domains, mailboxes, members]) => {
        if (active) setData({ domains, mailboxes, members });
      })
      .catch((e) => {
        if (active)
          setLoadError(
            e instanceof Error ? e.message : "Could not load organization",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, organization.id]);
  function rename(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(`/organizations/${organization.id}`, "PATCH", { name });
      await onRename();
    });
  }
  return (
    <>
      <header className="workspace-header">
        <div>
          <span className="eyebrow">ORGANIZATION WORKSPACE</span>
          <h1>{organization.name}</h1>
          <p className="muted">
            {organization.slug} <span aria-hidden="true">Â·</span> Your role:{" "}
            {organization.role}
          </p>
        </div>
        <span className="pilot-label">Development pilot</span>
      </header>
      <nav className="tabs" aria-label="Workspace">
        {(
          [
            "overview",
            "domains",
            "mailboxes",
            "webmail",
            "routing",
            "members",
            ...(canManage ? ["operations" as const, "billing" as const] : []),
            "account",
          ] as const
        ).map((item) => (
          <button
            key={item}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => setTab(item)}
          >
            {item === "account"
              ? "My account"
              : item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      <ErrorMessage message={loadError} />
      {loading ? (
        <p role="status" className="empty">
          Loading organizationâ€¦
        </p>
      ) : !data ? (
        <Empty>
          <button
            onClick={() =>
              void run(async () => {
                await reload();
                setLoadError("");
              })
            }
          >
            Retry loading
          </button>
          <ErrorMessage message={error} />
        </Empty>
      ) : (
        <div className="page-content">
          {tab === "overview" && (
            <>
              <div className="stats">
                <article className="card">
                  <span>Domains</span>
                  <strong>{data.domains.length}</strong>
                  <small>
                    {
                      data.domains.filter(
                        (d) => d.verification_status === "verified",
                      ).length
                    }{" "}
                    ownership verified
                  </small>
                </article>
                <article className="card">
                  <span>Mailbox configurations</span>
                  <strong>{data.mailboxes.length}</strong>
                  <small>Live mail integration pending</small>
                </article>
                <article className="card">
                  <span>Team members</span>
                  <strong>{data.members.length}</strong>
                  <small>Across owner, admin and member roles</small>
                </article>
              </div>
              <article className="card">
                <span className="eyebrow">YOUR NEXT STEPS</span>
                <h2>Prepare your organization</h2>
                <ol className="steps">
                  <li>
                    <button
                      className="text-button"
                      onClick={() => setTab("domains")}
                    >
                      Add and verify a domain
                    </button>
                    <p>Prove ownership with a DNS TXT challenge.</p>
                  </li>
                  <li>
                    <button
                      className="text-button"
                      onClick={() => setTab("mailboxes")}
                    >
                      Configure your mailboxes
                    </button>
                    <p>Choose addresses and 100 or 200 MB pilot quotas.</p>
                  </li>
                  <li>
                    <button
                      className="text-button"
                      onClick={() => setTab("members")}
                    >
                      Bring your team into the workspace
                    </button>
                    <p>Give registered users the access they need.</p>
                  </li>
                </ol>
              </article>
              <div className="notice">
                This dashboard manages configuration. Sending and receiving mail
                will require Phase 6 infrastructure integration.
              </div>
              {canManage && (
                <form className="inline-form card" onSubmit={rename}>
                  <label>
                    Organization name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={100}
                      required
                    />
                  </label>
                  <button disabled={busy}>Save name</button>
                  <ErrorMessage message={error} />
                </form>
              )}
            </>
          )}
          {tab === "domains" && (
            <Domains
              orgId={organization.id}
              domains={data.domains}
              canManage={canManage}
              reload={reload}
              isOwner={organization.role === "owner"}
            />
          )}{" "}
          {tab === "mailboxes" && (
            <Mailboxes
              isOwner={organization.role === "owner"}
              orgId={organization.id}
              domains={data.domains}
              mailboxes={data.mailboxes}
              canManage={canManage}
              reload={reload}
            />
          )}{" "}
          {tab === "webmail" && (
            <Webmail
              orgId={organization.id}
              mailboxes={data.mailboxes}
              members={data.members}
              isOwner={organization.role === "owner"}
            />
          )}
          {tab === "routing" && (
            <MailRouting
              orgId={organization.id}
              domains={data.domains}
              mailboxes={data.mailboxes}
              canManage={canManage}
            />
          )}
          {tab === "members" && (
            <Members
              orgId={organization.id}
              members={data.members}
              isOwner={organization.role === "owner"}
              reload={reload}
              reloadOrganization={onRename}
            />
          )}{" "}
          {tab === "account" && (
            <>
              <Account user={user!} />
              <Security />
              {organization.role === "owner" && (
                <SupportGrants key={organization.id} orgId={organization.id} />
              )}
            </>
          )}
          {tab === "operations" && canManage && (
            <Operations orgId={organization.id} />
          )}
          {tab === "billing" && canManage && (
            <Billing
              orgId={organization.id}
              isOwner={organization.role === "owner"}
            />
          )}
        </div>
      )}
    </>
  );
}
function Account({ user }: { user: User }) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const [profile, setProfile] = useState(user);
  return (
    <article className="card account-card">
      <span className="eyebrow">DASHBOARD IDENTITY</span>
      <h2>My account</h2>
      <dl className="dns-details">
        <dt>Email</dt>
        <dd>{profile.email}</dd>
        <dt>Account ID</dt>
        <dd>
          <code>{profile.id}</code>
        </dd>
        <dt>Joined</dt>
        <dd>{new Date(profile.created_at).toLocaleDateString()}</dd>
      </dl>
      <p className="muted">
        Your dashboard account is separate from any mailbox. Sessions expire
        renew securely while you use the dashboard. You can revoke them in
        security settings.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => setProfile(await api<User>("/auth/me")))
        }
      >
        Refresh profile
      </button>
      <ErrorMessage message={error} />
    </article>
  );
}
function Dashboard() {
  const { api, user, signOut } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]),
    [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true),
    [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState(""),
    [slug, setSlug] = useState("");
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const rows = await api<Organization[]>("/organizations");
    setOrganizations(rows);
    setSelected((current) =>
      rows.some((o) => o.id === current) ? current : (rows[0]?.id ?? ""),
    );
  }, [api]);
  useEffect(() => {
    void run(load).finally(() => setLoading(false));
  }, [load]);
  function create(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const org = await api<Organization>("/organizations", "POST", {
        name,
        slug,
      });
      await load();
      setSelected(org.id);
      setShowCreate(false);
      setName("");
      setSlug("");
    });
  }
  const organization = organizations.find((o) => o.id === selected);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          âœ‰ Nuvomailo
        </a>
        <div className="sidebar-workspace">
          <label>
            Organization
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!organizations.length}
            >
              {!organizations.length && (
                <option value="">No organizations</option>
              )}
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="sidebar-button"
            onClick={() => setShowCreate(!showCreate)}
          >
            + New organization
          </button>
        </div>
        <div className="sidebar-note">
          <span className="eyebrow">BUILT FOR YOUR TEAM</span>
          <p>
            One workspace for your domains, people, and mailbox configuration.
          </p>
          <small>Mail infrastructure pending Phase 6</small>
        </div>
        <div className="identity">
          <span>{user?.email}</span>
          <button className="sidebar-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <ErrorMessage message={error} />
        <Invitations reload={load} />
        <Platform />
        {showCreate && (
          <section className="card create-card">
            <h2>Create an organization</h2>
            <form onSubmit={create}>
              <label>
                Organization name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                />
              </label>
              <label>
                Unique slug
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  minLength={3}
                  maxLength={63}
                  placeholder="your-team"
                  required
                />
              </label>
              <div className="actions">
                <button className="primary" disabled={busy}>
                  Create organization
                </button>
                <button type="button" onClick={() => setShowCreate(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}
        {loading ? (
          <p role="status" className="empty">
            Loading your organizationsâ€¦
          </p>
        ) : organization ? (
          <Workspace
            key={organization.id}
            organization={organization}
            onRename={load}
          />
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <span className="eyebrow">LETâ€™S GET STARTED</span>
                <h1>Your workspace starts here.</h1>
                <p className="muted">
                  Create an organization to manage domains, people, and mailbox
                  configuration.
                </p>
              </div>
            </header>
            <Empty>
              <button className="primary" onClick={() => setShowCreate(true)}>
                Create your first organization
              </button>
              <button onClick={() => void run(load)}>
                Refresh organizations
              </button>
            </Empty>
            <Account user={user!} />
            <Security />
          </>
        )}
      </main>
    </div>
  );
}
function Content() {
  const { user, booting } = useAuth();
  if (booting) return <p role="status">Restoring your session…</p>;
  return user ? <Dashboard /> : <AuthPage />;
}
export default function App() {
  return (
    <AuthProvider>
      <Content />
    </AuthProvider>
  );
}
