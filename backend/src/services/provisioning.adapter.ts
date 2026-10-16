export interface ProvisioningRequest {
  id: string;
  mailbox_id: string;
  operation:
    | "create"
    | "set_quota"
    | "suspend"
    | "resume"
    | "reconcile"
    | "domain_custody";
  quota_mb: number;
  revision: number;
  desired_status: "active" | "suspended";
  inbound_policy: "accept" | "defer";
}
export interface MailboxTarget {
  organizationId: string;
  mailboxId: string;
  address: string;
  revision: number;
  quotaMb: number;
  status: "active" | "suspended";
  inboundPolicy: "accept" | "defer";
  idempotencyKey: string;
}
export interface MailboxObservation {
  status: "unknown" | "absent" | "active" | "suspended";
  quotaMb: number | null;
  inboundPolicy: "unknown" | "accept" | "defer";
}
export type EnsureResult = { status: "deferred" } | { status: "applied" };
/** Worker-only interface. Providers must fence stale revisions and honor cancellation.
 * Ensure is idempotent by mailbox revision and request key; inspect reads actual state.
 * Every revision must be accepted through ensure, including already-correct state,
 * before acknowledgement. Observation alone cannot establish the remote fence.
 * Credentials are resolved privately in the provider, never carried in this contract.
 */
export interface MailProvisioningAdapter {
  readonly mode: "pending-phase-6" | "local-lab" | "live";
  inspect(
    target: MailboxTarget,
    signal: AbortSignal,
  ): Promise<MailboxObservation>;
  ensure(target: MailboxTarget, signal: AbortSignal): Promise<EnsureResult>;
}
export class ProvisioningError extends Error {
  constructor(
    public code:
      | "PROVIDER_UNAVAILABLE"
      | "PROVIDER_REJECTED"
      | "CREDENTIALS_REQUIRED"
      | "STATE_MISMATCH"
      | "OPERATION_TIMEOUT",
    public retryable: boolean,
  ) {
    super(code);
  }
}
export class PendingProvisioningAdapter implements MailProvisioningAdapter {
  readonly mode = "pending-phase-6" as const;
  async inspect(
    _target: MailboxTarget,
    _signal: AbortSignal,
  ): Promise<MailboxObservation> {
    return { status: "unknown", quotaMb: null, inboundPolicy: "unknown" };
  }
  async ensure(
    _target: MailboxTarget,
    _signal: AbortSignal,
  ): Promise<EnsureResult> {
    return { status: "deferred" };
  }
}
