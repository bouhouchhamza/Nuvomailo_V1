# Billing renewal foundation

Status: locally tested synthetic foundation; no merchant, charge, tax service or live payment credential is configured.

Migration4760 adds immutable renewal requests captured from the current subscription revision, period end, plan price, currency and entitlement snapshot. Scheduling serializes on the subscription row. A due canceled subscription closes without a request; an expired trial or unconfigured-provider subscription enters seven-day grace; a due active sandbox subscription enters grace and creates one deduplicated request.

Provider work runs outside the claim transaction with the request UUID as its stable idempotency key. The local synthetic provider records only request identity, a fixed outcome and a provider-reference digest. A confirmed success extends the captured period exactly once. A confirmed failure records a failed invoice and keeps the subscription in the existing grace window. Transport failure retries only the same key; after the attempt bound, the request becomes `uncertain` and cannot be selected automatically. Every result rechecks the exact stored subscription revision and prior period before changing subscription state. A late result becomes `superseded` and creates no invoice.

Existing mailbox and message data are never removed by billing transitions. Expired grace restricts expansion through entitlements and leaves mail retention to its separate reviewed policy. Current usage rollups cannot create a renewal request, invoice or charge.

Local evidence on15 October2026:

- isolated migration up/down and runtime-role grants pass;
- scheduling replay and row claims are transactionally serialized;
- crash-after-effect replay produces one synthetic effect and one invoice;
- explicit success/failure, stale revision, cancel-at-period-end and terminal uncertainty pass;
- full regression passes35 backend/36 frontend; typechecks and production builds pass;
- the opt-in synthetic runner returns `idle` against an empty queue.

Production decisions still required: merchant and tax provider, stored provider customer/payment references, mandate and retry rules, price-change notice and grandfathering, proration, refunds/credits, invoice numbering and tax evidence, supported currencies, trial conversion, dunning communications, grace length, consumer rights, data retention, reconciliation and dispute workflows. These decisions require owner, legal and accounting review before any live provider adapter is enabled.
