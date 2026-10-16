# Next milestone: controlled mail integration proposal

**Current update:** the synthetic DMS spike and secure-foundation lab changes are implemented. The [secure foundation](SECURE_MAIL_FOUNDATION.md) now defines independent suspension policies, restricted listener/helper boundaries and proposed credential onboarding. This original proposal remains historical context for the production decisions; real credentials and public integration remain disabled.

> **Current update:** the owner approved DMS as an isolated local candidate, and the lab is implemented and executed. See [lab design/runbook](DMS_CONFORMANCE_LAB.md) and [actual capability/results matrix](DMS_CONFORMANCE_RESULTS.md). This proposal's original pending status below is historical. Production credential/agent design, receiving suspension policy and final topology remain unapproved.

Status: design prepared, not enabled or deployed. The audit shortlist and primary sources are in [ARCHITECTURE.md](ARCHITECTURE.md). This proposal makes the next operational decision reviewable; it does not select the final production mail topology.

## Recommended next experiment

Use Docker Mailserver as the first **isolated local conformance spike**, with synthetic domains/accounts, no published ports, public DNS, real mail or VPS changes. Preserve Stalwart/mailcow as alternatives and benchmark the same tests before a production choice. DMS aligns with the original stack, while its CLI/file boundary forces validation of the management-agent design early. This is an architectural recommendation, not an operational action already taken.

## Integration boundary

Only the separate worker may reach a private restricted management agent. The public API writes intent/jobs/audit only. The agent accepts typed mailbox identifiers/address, desired revision, quota/active-or-suspended state and a stable idempotency key; it exposes only actual inspect and idempotent ensure. It cannot accept shell strings, arbitrary container names, paths, commands or tenant-supplied credentials. Target node identity and address ownership derive from trusted persisted mappings.

Before a real adapter is added, specify authenticated transport (prefer a local private socket for a same-host spike; authenticated encrypted transport for separated hosts), least privilege, agent operation allowlist, per-mailbox atomic serialization, stored latest revision and stale-revision rejection. A worker lease token fences DB updates only. The remote boundary must independently reject an older revision after a newer one is applied. Test crash-after-effect, replay and late timeout completion.

## Credential design requiring review

Dashboard identity must never become mailbox credentials. The proposed agent resolves an opaque credential reference through a restricted credential provider, materializes only provider-compatible hashes where possible, and returns no reusable secret in job results. A future one-time setup/reset flow is authenticated, expiring and audited. No plaintext password enters argv, queue/audit rows or logs. Password setup/delivery/recovery, hash compatibility, secret encryption/access/rotation and webmail/IMAP authentication need an owner-reviewed choice before credentials or live accounts are provisioned.

This iteration deliberately implements none of that operational credential storage. It adds no credentials, package for an external secret service, Docker socket access or provider activation flag.

## Acceptance evidence required

1. Independent inspect accurately distinguishes absent/active/suspended and actual quota; authentication suspension semantics are confirmed, including inbound mail behavior.
2. Replayed ensure changes no already-correct state and cannot revert a newer revision.
3. Creation and quota changes use consistent provider configuration; partial create-before-quota failure is recoverable.
4. Timeouts/cancellation, provider restart, lease expiry and crash-after-effect converge safely.
5. Domain/address collisions, cross-tenant target substitution, shell/path injection and credential leakage are rejected.
6. Mail/configuration/key backups restore into a clean isolated instance; retained queues reconcile correctly.
7. Resource usage measured with intended spam/malware/TLS/storage features, realistic message sizes and concurrent clients.

After those tests, prepare a version-pinned production topology with provider port/PTR/IP checks, DNS change plan, sending-abuse controls, mail-node assignment/migration, backups/RPO/RTO, costs, monitoring and staged rollout/rollback. Public infrastructure, paid services, DNS and live email remain explicitly approval-gated by the project owner's instructions.

## Decisions needed before operational integration

- Approve which candidate to test first and the isolated environment; this proposal recommends a local DMS spike, not production selection.
- Review private-agent credential/transport and one-time mailbox setup design before enabling real credentials.
- Select support/licensing, backup destination, retention/RPO/RTO and production capacity only after conformance/measurement evidence exists.

Until then, the production-compatible execution model is under local test, while mail functionality remains disabled. Webmail, billing, entitlements, identity hardening and later scale/DR milestones remain explicit in the full-product roadmap.
