import * as queue from "../repositories/provisioning.repository.js";
import {
  PendingProvisioningAdapter,
  ProvisioningError,
  type MailProvisioningAdapter,
  type MailboxTarget,
  type MailboxObservation,
} from "../services/provisioning.adapter.js";
export interface WorkerOptions {
  allowLabAdapter?: boolean;
  leaseMs?: number;
  timeoutMs?: number;
  deferredMs?: number;
  baseBackoffMs?: number;
  organizationId?: string;
}
function matches(actual: MailboxObservation, target: MailboxTarget) {
  return (
    actual.status === target.status &&
    actual.quotaMb === target.quotaMb &&
    actual.inboundPolicy === target.inboundPolicy
  );
}
async function bounded<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProvisioningError("OPERATION_TIMEOUT", true));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export class ProvisioningWorker {
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  constructor(
    private adapter: MailProvisioningAdapter = new PendingProvisioningAdapter(),
    private options: WorkerOptions = {},
  ) {
    if (adapter.mode === "local-lab" && !options.allowLabAdapter)
      throw new Error(
        "Local lab adapter requires explicit isolated-worker opt-in",
      );
    this.leaseMs = options.leaseMs ?? 60000;
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (this.timeoutMs < 1 || this.leaseMs < this.timeoutMs * 3 + 1000)
      throw new Error(
        "Lease must exceed three adapter timeouts plus acknowledgement margin",
      );
  }
  async runOnce(): Promise<
    "idle" | "completed" | "deferred" | "failed" | "stale"
  > {
    const job = await queue.claim(this.leaseMs, this.options.organizationId);
    if (!job) return "idle";
    const target = queue.target(job);
    try {
      if (job.exhausted) {
        const done = await queue.finish(job, {
          kind: "failed",
          code: "LEASE_EXHAUSTED",
          retryable: false,
          delayMs: 0,
        });
        return done ? "failed" : "stale";
      }
      if (!job.domain_verified && job.operation !== "domain_custody") {
        const done = await queue.finish(job, {
          kind: "failed",
          code: "DOMAIN_NOT_VERIFIED",
          retryable: false,
          delayMs: 0,
        });
        return done ? "failed" : "stale";
      }
      if (
        this.adapter.mode !== "pending-phase-6" &&
        !job.domain_enabled &&
        job.operation !== "domain_custody"
      ) {
        const done = await queue.finish(job, {
          kind: "deferred",
          delayMs: this.options.deferredMs ?? 300000,
        });
        return done ? "deferred" : "stale";
      }
      let observation = await bounded(this.timeoutMs, (signal) =>
        this.adapter.inspect(target, signal),
      );
      // Even an already-correct state must accept this revision remotely. Otherwise
      // a delayed older ensure could revert it after we acknowledge the newer job.
      const result = await bounded(this.timeoutMs, (signal) =>
        this.adapter.ensure(target, signal),
      );
      if (result.status === "deferred") {
        const done = await queue.finish(job, {
          kind: "deferred",
          delayMs: this.options.deferredMs ?? 300000,
        });
        return done ? "deferred" : "stale";
      }
      observation = await bounded(this.timeoutMs, (signal) =>
        this.adapter.inspect(target, signal),
      );
      if (!matches(observation, target))
        throw new ProvisioningError("STATE_MISMATCH", true);
      // Non-production adapters cannot acknowledge provider success, even if they misreport a match.
      if (
        this.adapter.mode !== "live" &&
        !(this.adapter.mode === "local-lab" && this.options.allowLabAdapter)
      ) {
        const done = await queue.finish(job, {
          kind: "deferred",
          delayMs: this.options.deferredMs ?? 300000,
        });
        return done ? "deferred" : "stale";
      }
      const done = await queue.finish(job, { kind: "completed", observation });
      return done ? "completed" : "stale";
    } catch (error) {
      const known = error instanceof ProvisioningError;
      const base = this.options.baseBackoffMs ?? 1000;
      const delay = Math.round(
        Math.min(
          base *
            2 ** Math.max(job.attempts - 1, 0) *
            (0.8 + Math.random() * 0.4),
          3600000,
        ),
      );
      const done = await queue.finish(job, {
        kind: "failed",
        code: known ? error.code : "PROVIDER_UNAVAILABLE",
        retryable: known ? error.retryable : true,
        delayMs: delay,
      });
      return done ? "failed" : "stale";
    }
  }
}
