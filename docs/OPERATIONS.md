# Local worker operations and recovery

> Additional isolated DMS candidate lab is now implemented: [lab runbook](DMS_CONFORMANCE_LAB.md), [executed results](DMS_CONFORMANCE_RESULTS.md). Only explicit lab entry points opt into `local-lab`; this document's normal API/worker commands still use the pending adapter. Successful actual state in the lab database never enables customer mail in the development database.

14 October 2026. This runbook describes local orchestration only. It does not authorize public DNS, VPS changes, live mail, spending or production deployment.

## Processes and readiness

Run PostgreSQL via existing Compose, API/frontend via README commands. After migrations, start a separate worker with `npm --prefix backend run worker`; `-- --once` runs scheduling plus one claim. Built entry point: `npm --prefix backend run worker:start`. All runtime construction uses `PendingProvisioningAdapter`; there is intentionally no environment switch to activate a real provider.

`GET /api/health` is process liveness. `GET /api/ready` checks database connectivity and reports `mailReady:false`; it is not a mail readiness probe. Request logs are JSON with generated `X-Request-Id`, method, static route pattern, status and duration. They omit bodies, query strings, tokens and email addresses. Worker lifecycle/tick logs omit credentials/provider raw exceptions. Store/rotate/ship these logs with access control in a future deployment; no central collector or alert service is installed.

Worker defaults: poll 2 seconds, lease 60 seconds, per-adapter-call timeout 15 seconds, five attempts, exponential retry starting at one second and capped at one hour, development deferral five minutes. Lease must exceed three adapter call timeouts plus a DB acknowledgement margin. No long mail call occurs in a DB transaction. No heartbeat is currently needed for bounded calls; real provider operations exceeding these bounds need a renewed-lease/operation protocol.

`WORKER_POLL_MS` (100–60000), `WORKER_RECONCILE_INTERVAL_MS` (60000–86400000, default 300000), and `WORKER_RECONCILE_AFTER_MS` (60000–604800000, default 3600000) are validated config. Scheduler runs bounded batches of 50 previously applied mailboxes whose observation is stale and with no outstanding work. There is no reconciliation claim for never-provisioned pending mailboxes; their initial job already represents intent.

## States and queue behavior

Mailbox `quota_mb`, `desired_status`, `desired_revision` represent requested configuration. `observed_status`, `observed_quota_mb`, `observed_at`, `applied_revision` represent independently confirmed provider state. Observations may become stale. A provider configuration observation alone still does not establish credential, TLS, DNS or delivery readiness; `liveMailAvailable` remains false.

Request states: `pending`, `processing` with token/expiry, `completed`, `failed` (dead letter). `(mailbox_id,revision)` is unique. Immutable snapshots include target state/quota. Requests are processed in revision order per mailbox. A failed head blocks newer work for that mailbox, not other mailboxes. Claiming uses short mailbox/job locks and `SKIP LOCKED`. Updates and acknowledgements use the same mailbox-first lock order. API authorization uses a shared membership lock before resource writes; role removal/demotion waits for an admitted write transaction.

The pending adapter returns unknown/deferred, schedules the job later and restores its attempt count. It never turns a mailbox active. Real provider adapters are not implemented. A real adapter must honor cancellation, implement idempotent full-state ensure/actual inspect, and fence stale revisions at the remote management boundary.

## Investigating and retrying

As organization owner/admin, open **Operations** or query `/api/organizations/:orgId/provisioning-requests`. Inspect attempts, safe code, revision, next eligible time and lease expiry. Audit history is separately available at `/audit-events`. Both accept `limit` (1–100) and `before` keyset cursor; lease tokens/raw provider errors are never exposed. Members and outsiders cannot access these admin views.

- `INTEGRATION_PENDING`: expected without real mail integration; do not force success.
- `PROVIDER_UNAVAILABLE`, `OPERATION_TIMEOUT`, `STATE_MISMATCH`: transient errors use bounded retry/backoff. Timeout can still have a late external side effect, so inspect/reconciliation and provider fencing are essential.
- `PROVIDER_REJECTED`, `CREDENTIALS_REQUIRED`, `DOMAIN_NOT_VERIFIED`: permanent/classified failure needs cause review.
- `LEASE_EXHAUSTED`: repeated worker death exhausted the claim budget; inspect the provider before retrying.

After resolving the cause, `POST /organizations/:orgId/provisioning-requests/:requestId/retry` resets a dead-lettered request to pending, preserves its revision/idempotency key and records the actor in audit. Only failed jobs can be reset; processing leases cannot be stolen via customer API. Repeated manual retries are audited but not an unlimited autonomous retry loop.

`POST /organizations/:orgId/mailboxes/:mailboxId/reconcile` queues a fresh desired-state revision only when no request is outstanding and the domain is verified. It inspects before ensure, then independently observes actual state. Scheduler performs the same pattern for stale applied mailboxes. A newer intent committed while an older job executes remains pending; an older completion cannot overwrite newer desired state.

## Crash and restore handling

Graceful worker stop finishes the current bounded operation, stops polling and closes DB connections. Abrupt death leaves a lease; after expiry another worker reclaims the same request with a new lease token. Late acknowledgements from the old token are rejected. If the provider already applied the state, inspection avoids repeated ensure. Stable idempotency keys and remote revision fencing are still required: DB fencing cannot cancel a network side effect or create exactly-once execution.

Metadata and mail storage must eventually be restored consistently, including credential material, certificates/keys, queue state and node mapping. Stop writers/workers during a coordinated restore; review restored intent and reconcile against real provider state before reopening. No backup job, off-host destination, point-in-time restore, RPO/RTO or restore drill exists yet. Do not claim recovery readiness until these are tested on a separate approved environment.

## Migration and deployment limits

Added migrations `1791977444734_durable-provisioning` and `1791977444735_reconciliation-operations`. Existing jobs are preserved and receive deterministic historical revisions/state snapshots; unknown observations remain unknown. Timestamp ties cannot reconstruct original operation order. Review existing backlog and credential/provider mapping before enabling real integration.

Down migrations are tested only in isolated schemas and drop newly added metadata/audits. Do not roll them back in production as an operational repair. Reconciliation-operation rollback maps its intent to a quota operation while retaining the then-current snapshot; production uses a reviewed expand/contract migration and backups instead.

Current API/worker share the development DB role. Separate roles/grants, durable authentication limiting, resource ceilings, log aggregation/metrics/alerts, audit retention/integrity, final mail adapter/agent credentials and topology are required before exposure. Do not mount the Docker socket into the API or use raw shell arguments for provisioning.
