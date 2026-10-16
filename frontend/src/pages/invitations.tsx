import { useState } from "react";
import { useAuth } from "../auth";
import { useAction, ErrorMessage } from "../components";
interface Invitation {
  id: string;
  organization_name: string;
  role: string;
  expires_at: string;
}
export function Invitations({ reload }: { reload: () => Promise<void> }) {
  const { api } = useAuth(),
    { busy, error, run } = useAction();
  const [items, setItems] = useState<Invitation[] | null>(null);
  const load = async () => setItems(await api<Invitation[]>("/invitations"));
  return (
    <section className="card">
      <h2>Your invitations</h2>
      <p>
        Verify your dashboard email before accepting invitations. Invitations
        expire after seven days.
      </p>
      <button disabled={busy} onClick={() => void run(load)}>
        Check invitations
      </button>
      <ErrorMessage message={error} />
      {items &&
        (!items.length ? (
          <p>No available invitations for your verified email.</p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                {item.organization_name} — {item.role}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/invitations/${item.id}/accept`, "POST");
                      await load();
                      await reload();
                    })
                  }
                >
                  Accept invitation
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
