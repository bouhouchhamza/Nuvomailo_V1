# Architecture decisions

14 October 2026. This log supersedes demo-only assumptions in ADR-0001 while retaining its useful modular architecture. Production mail topology remains undecided.

| ID | Status | Choice and rationale | Tradeoffs / revisit condition |
| --- | --- | --- | --- |
| AD-001 | Accepted | Long-lived modular TypeScript control plane, React view, separate worker process; Controller → Service → Repository | Shared code/database reduce operations; split only for measured load/trust/release isolation |
| AD-002 | Accepted | Separate control, asynchronous, mail and webmail boundaries; no Docker/socket/shell credentials in API | Requires explicit restricted adapter/agent and separate runtime roles before production |
| AD-003 | Accepted initially | PostgreSQL requests as transactional queue/outbox; intent/job/audit atomic | Poll/index/DB contention must be measured; introduce broker only with outbox publisher when justified |
| AD-004 | Accepted | Full desired-state snapshots, monotonic revisions and independent actual observations | Additive backfill; `quota_mb` stays requested quota; HTTP 202 and queued suspension are never actual success |
| AD-005 | Accepted | At-least-once execution, stable request idempotency key, lease-token DB fencing, ordered mailbox heads, bounded retry/dead letters | No exactly-once external promise. Real agents must reject stale revisions; dead heads need reviewed retry |
| AD-006 | Accepted | Authorize tenant mutations inside same transaction with membership row lock; reauthorize recording after DNS network lookup | Explicit transaction/client signatures; RLS evaluation later with runtime DB roles; no network calls under DB locks |
| AD-007 | Accepted | Scoped bounded audit/operational APIs, generated request IDs and allowlisted logs/codes | Application append-only audit is not tamper-proof; production retention/grants/integrity export still needed |
| AD-008 | Development only | Default worker adapter defers and observes unknown; success adapters only test fixtures | Tests can prove orchestration, never live mail/credentials/deliverability |
| AD-009 | Evaluation pending | DMS candidate, not final topology; compare Stalwart/mailcow using same conformance/security/recovery criteria | No benchmark yet. Stalwart documented tenant support is Enterprise-only; terms need review. [Official tenant docs](https://stalw.art/docs/auth/authorization/tenants/) |
| AD-010 | Decision required | Restricted credential onboarding/rotation; dashboard password never reused for mailbox | Need provider hash compatibility, safe delivery/recovery and remote fencing; no plaintext argv/job/logs |
| AD-011 | Accepted | Additive migrations preserve pending requests and unknown observations | Historical timestamp ties cannot recover true order; review backlog before live activation. Production down migrations risk history loss |
| AD-012 | Accepted | Measure capacity/RPO/RTO/filtering/storage/latency/queue before production sizing | Small VPS is testing only; no Kubernetes/microservices without evidence |
| AD-013 | Planned | Explicit entitlements, node assignment, retention/deprovisioning, domain transfer and audited operator modules | Avoid placeholder billing/webmail functionality before prerequisites |

## Real adapter acceptance gate

### Secure integration foundation (local only)

- **AD-018:** Independent authentication and inbound policies. Existing `suspended` remains authentication-only; lab `inboundPolicy=defer` uses SMTP RCPT 450 before DATA. Accepted queues remain owned by the receiver; no DISCARD. Public schema/UI migration remains future work.
- **AD-019:** Unix listener drops to dedicated UID3001/GID3000; root lab helper uses only an inherited socketpair and revalidates typed requests. Root helper sandboxing/production packaging remain unapproved. Random exclusive no-follow atomic writes and credential-free structured security events reduce local attack surface.
- **AD-020:** New synthetic accounts use native Dovecot ARGON2ID, tested over IMAP/submission. Production setup/reset/rotation uses a proposed single-use authenticated grant and scoped encrypted hash reference, independent of dashboard identity. No custom hash encoding or live credential service implemented.
- **AD-021:** Domain ownership is rechecked by a PostgreSQL-backed scheduler with one outstanding revision per domain, recoverable leases and DNS effects outside transactions. Missing proof warns for 30 days; a post-grace result fences stale work and queues custody, but can never release a name.
- **AD-022:** Failed-domain custody means authentication disabled plus temporary SMTP recipient deferral, preserving stored data and leaving retry responsibility with the sender. Ownership recovery does not automatically reactivate mailboxes. Warning delivery uses an idempotent transactional outbox and a separate least-privilege identity; only an explicit digest-only synthetic transport is currently enabled.
- **AD-023:** Webmail send idempotency is an at-most-one-automatic-effect policy. A caller UUID is bound to the validated content digest before SMTP; accepted outcomes replay from a content-free summary, while provider errors or abandoned processing become `uncertain` and are never submitted again automatically. Operators/users must reconcile Sent/DSN state before composing with a new key. Personal contacts remain control-plane records scoped to one dashboard user and mailbox.

Policy matrix, credential sequence, residual risks and exact owner decisions: [secure foundation](SECURE_MAIL_FOUNDATION.md).

### Local conformance decisions (implemented, candidate only)

- **AD-014:** DMS 15.1.0/digest-pinned, no-port/internal-network lab; node-local typed agent over UID/GID+token-authenticated Unix socket. API/default worker remain pending-only; `local-lab` requires explicit worker opt-in. No Docker socket is mounted into any lab service. Node-root agent privilege remains a production review item.
- **AD-015:** Durable acceptance journal fences stale revisions before effects; node-wide lock serializes shared FILE-provisioner configuration. Real local crash/partial/retry/drift/restart scenarios passed. This does not establish multi-node or exactly-once guarantees.
- **AD-016:** Authentication suspension is distinct from receiving policy. Local deny passdb blocked IMAP/SMTP login, retained mail and restored successfully; inbound delivery continued. Production policy is undecided.
- **AD-017:** Synthetic SHA512-CRYPT and Dovecot ARGON2ID worked; raw SaaS-library Argon2 encoding was rejected until canonical parameter order was used in the compatibility probe. No SaaS credential reuse or production normalization/onboarding flow is approved.

See [executed evidence](DMS_CONFORMANCE_RESULTS.md). DMS is approved as the first local candidate only; final provider/topology, real credentials, public services/DNS/email and spending remain decision-gated.

Independent `inspect` and idempotent full-state `ensure` receive trusted tenant/mailbox IDs, immutable address, desired revision, quota/target state, stable request idempotency key and cancellation. Return independently observed provider state; use bounded safe failure codes with retry classification. Do not echo desired state as observation. Keep credentials and raw exceptions out of persistence/logs. Remote revision fencing and credential design precede enabling the first real adapter.

## Audit conclusion

15 October implemented continuation decisions (superseding earlier design-only statements where applicable):

- Credential job acknowledgement reports the fenced DB outcome, including superseded generation or lost lease; provider completion alone is insufficient evidence of application success.
- Runtime API, ordinary worker and migration owner use separate DB identities and fixed secret file paths. Worker receives no signing/identity/mail secret. Closed synthetic startup/restart passes; later migrations must be rebuilt/rehearsed before release.
- Support consent is a named-staff, expiring diagnostics-read grant, with current owner/MFA/session checks, aggregate-only output and audited revocation. It never impersonates a tenant or grants message access. See [support policy](SUPPORT_ACCESS.md).
- Retention is reversible authentication-suspension intent, reserves resources and never schedules deletion or changes inbound delivery policy. Explicit restoration queues a new revision. See [retention semantics](MAILBOX_RETENTION.md).
- Internal incidents are a version-fenced operator workflow, not service-health proof or configured alert transport. See [incident operations](INCIDENT_OPERATIONS.md).
- Domain ownership uses repeated proof with a 30-day warning grace. Owner-reauthenticated release is permitted only while activation, mailbox and routing custody markers are all permanently empty; the archive retains a name digest rather than the plaintext name. Automatic release is prohibited. See [domain revalidation and release](DOMAIN_REVALIDATION.md).
- Unattended ownership checks, verified-owner warning outbox and failed-domain custody are revision-fenced and locally tested. The existing DMS primitive returns `450` before DATA and preserves mail; production scheduler/notification deployment and a current controller-to-DMS/restore rehearsal remain open.

The existing control-plane APIs/UI are locally tested foundations. Missing critical boundaries are reliable asynchronous execution, trustworthy actual state, transactional audit, revocation-consistent writes and operational visibility. Implement these before mail-system integration. Full product dependencies/acceptance criteria are in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md).
