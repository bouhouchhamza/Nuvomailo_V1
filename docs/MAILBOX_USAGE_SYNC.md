# Mailbox usage synchronization

15 October2026. Migration4752 and the isolated DMS adapter implement actual provider usage observations without enabling a live provider.

The control plane stores the latest provider-observed byte and message counts, observation time and bounded error code separately from configured quota. API responses label measurements `unknown`, `fresh` (at most15 minutes old) or `stale`; a refresh failure preserves the last good values and exposes the safe error code. No missing, failed or old observation is converted into zero usage.

Tenant managers can request a refresh only for an active verified mailbox whose domain has an explicitly enabled provider. One pending/processing request per mailbox deduplicates concurrent requests. The worker uses leases, bounded retries and timeout cancellation; successful and failed acknowledgements require the current unexpired lease. A late or replaced lease cannot overwrite usage. Scheduled refresh inserts are bounded, lock mailboxes and skip outstanding work. The ordinary deployment worker receives only usage queue and mailbox observation privileges, not mail credentials.

The lab agent adds only `/v1/usage`. It derives organization, mailbox and address authorization from the fixed trusted binding, accepts no path or command, and invokes fixed `doveadm -f json quota get -u <trusted address>` arguments without a shell. Dovecot reports storage in KiB and messages as integers; the agent validates bounds and converts storage to bytes. Logs contain only result codes.

Actual isolated evidence: the native provider returned100,725,760 bytes and66 messages for the retained synthetic pilot mailbox. The durable worker persisted the identical values, rejected unauthenticated and cross-tenant target substitution, and matched them again after restarting the mail provider. The runner stops mail/database services and retains all volumes. These values describe a synthetic fixture, not capacity or customer usage.

Migration4759 adds a tenant-isolated current organization rollup. It totals observed bytes/messages and allocated quota while preserving fresh, stale and unknown mailbox counts. The API exposes the rollup only after tenant authorization and keeps BIGINT totals as decimal strings. Coverage is complete only when every included mailbox has a fresh observation. The result always reports `billingEligible:false`; complete observations still require approved pricing and commercial policy.

Remaining production gates: provider topology and dedicated read identity, fleet/node assignment, immutable billing-period snapshots, observation SLO/alerting, overflow behavior and independent load/security review. Current rollups are operational estimates. Usage does not enforce quota itself and is not invoice evidence until those gates pass.
