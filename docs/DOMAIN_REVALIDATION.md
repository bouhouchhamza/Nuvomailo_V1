# Domain ownership revalidation, custody and conservative release

Status: locally implemented and verified through 16 October 2026. Migrations 4753–4755 are applied to the development database, and the preserved closed stack has been upgraded through 4760. No public DNS, external notification provider, production scheduler or public mail service was enabled.

## Ownership policy

Initial TXT verification records a successful ownership observation and schedules the next check for 30 days later. Manual checks are tenant-authorized inside each write transaction and limited to one per minute. The unattended scheduler selects due domains in bounded batches with `FOR UPDATE SKIP LOCKED`, increments a monotonic domain revision and creates at most one outstanding request per domain. Each execution has a lease, bounded DNS timeout, five-attempt limit and stable request identity. Expired leases can be recovered; a stale revision, changed challenge, inactive tenant or changed verification state is superseded before DNS lookup or before result acknowledgement.

`ENODATA` and `ENOTFOUND` mean proof is absent. Other resolver failures retry without changing ownership state. The first absent proof enters `warning`, retains ownership and begins a 30-day grace period. A matching proof restores `current`; an absent proof after the stored deadline changes ownership to `failed` and disables control-plane mail activation. No path automatically releases a domain.

## Notification delivery

State transitions create one warning, failure or recovery outbox event per verified active owner and revalidation revision. Delivery rechecks that the recipient is still a verified active owner and that the event still matches the domain state. Ineligible or superseded events are canceled; expired processing leases clear safely and can be recovered. Delivery uses the outbox UUID as an idempotency key, so a crash after the transport effect can be replayed without a duplicate effect.

The only implemented transport is an explicit local synthetic adapter. It writes the event kind, recipient user ID and SHA-256 address digest to durable evidence and never writes the email address or message body. It is rejected unless the runner receives `--local-synthetic`. A real provider, templates, escalation rules and delivery credentials remain unconfigured.

## Mail custody after grace expiry

Authentication state and inbound recipient policy are separate desired and observed fields:

| State                                | IMAP and authenticated submission | SMTP inbound                         | Stored mail | Return to service                                |
| ------------------------------------ | --------------------------------- | ------------------------------------ | ----------- | ------------------------------------------------ |
| Fully active                         | Allowed                           | Accepted                             | Preserved   | No action                                        |
| Authentication suspended or retained | Denied                            | Accepted and stored                  | Preserved   | Explicit resume queues a new revision            |
| Failed ownership custody             | Denied                            | Temporary `450` at RCPT, before DATA | Preserved   | Renew proof, then explicitly resume each mailbox |

Both scheduled and manual post-grace failures atomically queue a `domain_custody` snapshot for every mailbox that is not already suspended with inbound deferral. The normal worker still refuses ordinary operations for an unverified domain, but accepts this restricted custody operation. Revision fencing and per-mailbox serialization prevent an older request from reverting a newer policy. Recovery of domain ownership never silently resumes authentication or receiving; an owner must explicitly restore mailbox service after proof is renewed.

The isolated DMS security suite measured the provider primitive: authentication-only suspension rejected IMAP/submission while accepting and storing inbound mail; inbound deferral returned SMTP `450` before DATA without increasing the message count; restart preserved the restriction; reactivation accepted the retried message and preserved existing mail. The current controller-to-DMS drill now queues the real domain-wide custody transition, applies it through the revision-fenced worker/private agent and verifies the known mailbox against real IMAP, submission and SMTP. It preserved 47 messages during custody and restart, then accepted one retried message after explicit reactivation for a final count of 48.

## Empty-domain release

Release requires owner role, active session, verified identity, recent MFA when configured, dashboard-password reauthentication, exact normalized domain-name confirmation and a fixed reason code. The database rejects release after any mail activation, mailbox, route, routing request or nonzero routing generation. These custody markers are sticky.

An accepted release archives the original IDs, fixed reason, timestamp and SHA-256 name digest, deletes only the empty control-plane row and makes the name reusable. It does not change DNS, provider configuration or mail data. Previously mail-activated domains can never use this release path.

## Schema and privileges

- Migration 4753 adds ownership observations, grace state and digest-only released claims.
- Migration 4754 adds revisioned leased revalidation requests, notification outbox and synthetic delivery evidence.
- Migration 4755 adds desired/observed inbound policy and immutable policy snapshots to provisioning requests.
- `nuvomailo_notification` can read domain/mailbox/tenant context, only the safe user identity columns needed for recipient checks, mutate its two queues, queue custody requests and append audits. It cannot read password hashes, sessions, MFA or mailbox credential artifacts. The ordinary mail worker cannot read identity or notification tables.

The preserved closed database and runtime images have been upgraded through migration 4760. Role bootstrap creates the notification role idempotently before additive migration/grant rehearsal; the role remains `NOLOGIN` until a separately managed runtime credential is approved. The latest signed recovery snapshot also contains all 30 migrations through 4760.

## Verification evidence

- Focused PostgreSQL tests pass for due scheduling, deduplication, concurrent claims, expired-lease recovery, DNS timeout/retry behavior, stale revision rejection before lookup, warning/failure transitions and manual plus scheduled custody queuing.
- Notification tests pass for verified-owner selection, crash-after-effect replay, one durable synthetic delivery, recipient-verification revocation, expired-lease cancellation and no secret/address persistence.
- Provider fixture execution applies `suspended/defer` and acknowledges the matching mailbox revision.
- The real controller-to-DMS custody drill passes six checks: domain-wide custody queuing, worker application, IMAP/submission denial, SMTP `450` before DATA with mail preservation, restart persistence and explicit reactivation/delivery.
- Runtime-grant tests prove the notification role's narrow access and ordinary-worker denial.
- A real headless Chromium test against the production frontend bundle exercises warning display, revalidation, exact-name/password release, exact API body, removal of the submitted password value and post-release removal of the domain.
- Current post-custody regression: 35 backend and 36 frontend tests pass. Both typechecks and production builds pass; the focused browser E2E remains accepted from the current frontend source state.

The latest current-schema signed/encrypted recovery and cold-node checks pass through migration 4760. Existing 17-check isolated DMS evidence and the new six-check custody drill support the provider behavior above. This remains synthetic local evidence and does not authorize live DNS, public delivery or production credentials.

## Remaining boundary

Production requires a reviewed scheduler cadence, dedicated notification service deployment and credentials, approved notification provider/content, alerting for queue age/dead letters, live DNS behavior evidence, deployment-specific DMS custody validation and a documented operator path for proof renewal and mailbox reactivation. Domain transfer or release with mail history remains prohibited until a separately approved mail-data migration/custody process exists.
