import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { ErrorMessage, useAction, Status } from "../components";
import type { Member } from "../types";
export function Members({
  orgId,
  members,
  isOwner,
  reload,
  reloadOrganization,
}: {
  orgId: string;
  members: Member[];
  isOwner: boolean;
  reload: () => Promise<void>;
  reloadOrganization?: () => Promise<void>;
}) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("member");
  const [direct, setDirect] = useState(false),
    [message, setMessage] = useState(""),
    [target, setTarget] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [invitations, setInvitations] = useState<
      | {
          id: string;
          email: string;
          role: string;
          revoked_at: string | null;
          accepted_at: string | null;
        }[]
      | null
    >(null);
  const path = `/organizations/${orgId}/members`;
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(direct ? path : `/organizations/${orgId}/invitations`, "POST", {
        email,
        role,
      });
      setMessage(
        direct
          ? "Member added."
          : "Invitation created. The recipient can accept from their verified account.",
      );
      setEmail("");
      await reload();
    });
  }
  return (
    <>
      <h2>People & permissions</h2>
      <p className="muted">
        Members can view. Admins manage domains and mailboxes. Owners also
        manage memberships.
      </p>
      <ErrorMessage message={error} />
      {message && <p role="status">{message}</p>}
      {isOwner && (
        <form className="inline-form card" onSubmit={submit}>
          <label>
            Recipient email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="primary" disabled={busy}>
            {direct ? "Add member" : "Create invitation"}
          </button>
          <small>
            Invitations appear in the recipient's verified dashboard account and
            expire after seven days. No invitation email is sent by this
            environment.
          </small>
          <label>
            <input
              type="checkbox"
              checked={direct}
              onChange={(e) => setDirect(e.target.checked)}
            />
            Add a registered member directly
          </label>
        </form>
      )}
      {isOwner && (
        <section className="card">
          <h3>Invitation management</h3>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setInvitations(
                  await api(`/organizations/${orgId}/invitations`),
                ),
              )
            }
          >
            Load invitations
          </button>
          {invitations && (
            <ul>
              {invitations.map((invite) => (
                <li key={invite.id}>
                  {invite.email} — {invite.role}{" "}
                  {invite.revoked_at ? (
                    "revoked"
                  ) : invite.accepted_at ? (
                    "accepted"
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/organizations/${orgId}/invitations/${invite.id}`,
                            "DELETE",
                          );
                          setInvitations(
                            await api(`/organizations/${orgId}/invitations`),
                          );
                        })
                      }
                    >
                      Revoke invitation
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>Transfer ownership</h3>
          <label>
            New owner
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a verified member</option>
              {members
                .filter((m) => m.role !== "owner")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.email}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I understand I will become an administrator
          </label>
          <button
            disabled={busy || !target || !confirmed}
            onClick={() =>
              void run(async () => {
                await api(
                  `/organizations/${orgId}/transfer-ownership`,
                  "POST",
                  { userId: target },
                );
                setConfirmed(false);
                await reloadOrganization?.();
                await reload();
              })
            }
          >
            Transfer ownership
          </button>
        </section>
      )}
      {!isOwner && (
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (
                !window.confirm(
                  "Leave this organization? Your membership will be removed.",
                )
              )
                return;
              await api(`/organizations/${orgId}/leave`, "POST");
              await reloadOrganization?.();
            })
          }
        >
          Leave organization
        </button>
      )}
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              {isOwner && <th>Manage</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id}>
                <td>{member.email}</td>
                <td>
                  <Status value={member.role} />
                </td>
                {isOwner && (
                  <td>
                    {member.role === "owner" ? (
                      <small>Protected owner</small>
                    ) : (
                      <div className="actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(`${path}/${member.id}`, "PATCH", {
                                role:
                                  member.role === "admin" ? "member" : "admin",
                              });
                              await reload();
                            })
                          }
                        >
                          Make {member.role === "admin" ? "member" : "admin"}
                        </button>
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(`${path}/${member.id}`, "DELETE");
                              await reload();
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
