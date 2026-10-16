export interface MailboxUsageTarget {
  organizationId: string;
  mailboxId: string;
  address: string;
}
export interface MailboxUsageObservation {
  usageBytes: number;
  messageCount: number;
}
export interface MailboxUsageReader {
  readonly mode: "unconfigured" | "local-lab" | "live";
  read(
    target: MailboxUsageTarget,
    signal: AbortSignal,
  ): Promise<MailboxUsageObservation>;
}
export class UsageProviderError extends Error {
  constructor(
    public code:
      "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "OPERATION_TIMEOUT",
    public retryable: boolean,
  ) {
    super(code);
  }
}
export class UnconfiguredUsageReader implements MailboxUsageReader {
  readonly mode = "unconfigured" as const;
  async read(): Promise<MailboxUsageObservation> {
    throw new UsageProviderError("PROVIDER_UNAVAILABLE", true);
  }
}
