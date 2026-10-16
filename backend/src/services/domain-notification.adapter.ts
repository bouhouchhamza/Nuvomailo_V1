import { createHash } from "node:crypto";
import pool from "../config/database.js";

export type DomainNotificationEvent = {
  idempotencyKey: string;
  outboxId: string;
  recipientUserId: string;
  recipientAddress: string;
  domainName: string;
  kind: "warning" | "failed" | "recovered";
};

export interface DomainNotificationTransport {
  readonly mode: "local-synthetic" | "unconfigured";
  deliver(event: DomainNotificationEvent, signal: AbortSignal): Promise<void>;
}

export class NotificationTransportError extends Error {
  constructor(
    readonly code: "TRANSPORT_UNAVAILABLE" | "OPERATION_TIMEOUT",
    readonly retryable = true,
  ) {
    super(code);
  }
}

export class SyntheticDomainNotificationTransport implements DomainNotificationTransport {
  readonly mode = "local-synthetic" as const;
  async deliver(event: DomainNotificationEvent, signal: AbortSignal) {
    if (signal.aborted)
      throw new NotificationTransportError("OPERATION_TIMEOUT");
    await pool.query(
      `INSERT INTO synthetic_notification_deliveries
      (outbox_id,idempotency_key,recipient_user_id,recipient_address_digest,kind)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        event.outboxId,
        event.idempotencyKey,
        event.recipientUserId,
        createHash("sha256").update(event.recipientAddress).digest("hex"),
        event.kind,
      ],
    );
  }
}
