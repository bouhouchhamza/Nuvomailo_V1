# Secure mail foundation — executed results

14 October 2026. [Security architecture and owner decisions](SECURE_MAIL_FOUNDATION.md). [Reviewed machine evidence](reports/secure-mail-foundation-2026-10-14.json). DMS remains a candidate, not a production selection.

## Actual changes

- Separate lab authentication state and inbound `accept/defer` policy; Postfix temporary recipient deferral persists through DMS configuration regeneration/restart. Independent inspection includes effective policy when explicitly requested; public SaaS API/schema remains unchanged.
- Socket listener runs as dedicated UID3001/GID3000 with no supplementary groups. Root lab helper revalidates every operation over an inherited socketpair; worker peer UID/GID and bearer authorization remain mandatory. No Docker socket, generic shell/command, tenant path or credential RPC added.
- Random exclusive O_NOFOLLOW atomic writes, symlink refusal, structured allowlisted security events and native Dovecot ARGON2ID for newly created synthetic accounts. Existing hashes are preserved.
- Worker always ensures remote revision acceptance even for already-matching state before acknowledgement. Regression covers this fence against a delayed older target. Lab ensure requires stable runtime observations after watcher settling; baseline can recover a retained pending head without deleting history.
- Credential setup/reset/rotation is documented design only: independent identity, authenticated expiring single-use grants, native hashing, scoped credential references, encrypted sensitive artifacts if recovery requires retention, remote generation fencing and no reusable job secret.

## Executed verification

`powershell -NoProfile -ExecutionPolicy Bypass -File infrastructure/mail-lab/run-conformance.ps1` exited **0**, producing raw ignored `20261014183243.json` and the reviewed report above.

| Scenario | Observed result |
| --- | --- |
| Native ARGON2ID | Synthetic security account authenticates over TLS IMAP and SMTP submission |
| Authentication-only suspension | Both new logins fail; SMTP recipient and DATA accepted and message stored |
| Inbound-only suspension | RCPT returns 450 while both client logins still work |
| Combined restriction | Both logins fail; RCPT returns 450 before DATA, stored-message count unchanged |
| Reactivation/retry | Both logins recover; resubmitted synthetic message accepted/stored; prior mail preserved |
| Credential/command exposure boundary | Password/hash/credential/path/command fields rejected; ensure response contains only applied status; journals contain no known synthetic password/hash/token |
| Agent authorization | Wrong peer UID returns403; wrong token401; unknown operation404 |
| Service/file restriction | UID3001 cannot read synthetic seed or write provider account config; symlink destination refused without changing victim |
| Log/argv sampling | No known security-fixture plaintext password, account hash or bearer token observed in inspected logs/process arguments; not a complete forensic guarantee |
| Replay/fencing | Same snapshot replay succeeds; stale revision and changed inbound policy under same key rejected |
| Restart restoration | Actual container restart preserves combined policy, authentication deny and remote fence; later reactivation succeeds |
| Earlier conformance regression | Provision/create/quota/idempotency/concurrency/tenant injection/partial recovery/collision/drift/acceptance-journal recovery pass |
| Worker crash | Expected exit77 after provider effect; new process recovers retained request and completes it |
| Mail quota | Preserved mailbox already near100 MiB; next8 MiB append rejected for quota, later200 MiB state restored |
| Backup | Quiescent metadata and mail byte restoration pass; archive100,812,800 bytes;22 pilot messages retained |

No new cold-boot restore was run in this iteration; the prior isolated cold-restore evidence remains separate. This run verifies restart restoration and fresh-directory snapshot byte comparison. The raw Node-library Argon2 hash continues to fail unchanged while the historical canonical-order probe succeeds; native Dovecot creation avoids relying on that transformation for the new path.

The first combined attempt exposed a real quota observation race: ensure saw a matching intermediate snapshot, then DMS's watcher applied an older captured configuration before the worker's follow-up inspect. That attempt failed STATE_MISMATCH and was not counted as a pass. Stable observation/settling and mandatory remote acceptance were implemented, followed by the successful complete rerun. Timing-based settling remains a FILE-provider limitation requiring a stronger production generation acknowledgement.

Regression commands: `npm run typecheck`, `npm test`, `npm run build` pass (**10 backend,9 frontend tests**). After the worker fence regression was extended, backend tests and typecheck passed again; the final backend build also passed. Frontend was unchanged. `git diff --check` passes, with existing newline normalization warnings.

## Shutdown, risks and handoff

Primary lab services stopped; retained mail container exit0, OOMKilled=false. Volumes/data/snapshots preserved. Existing development DB and unrelated containers unchanged. Public ports remain unbound, network internal, container not privileged. No real DNS/VPS/public SMTP/live accounts/production secrets, spending, reset/clean/commit/push.

Production gates remain: privileged helper sandboxing; real credential grant/reference implementation; MFA/recipient-proof/recovery/secret-provider decisions; aliases/catch-all/forwarding, existing SMTP sessions and already-accepted queues; provider generation/fencing recovery after backup rollback; filtered load/abuse/TLS/deliverability and encrypted coordinated off-host restore. See the [exact owner decisions and next milestone](SECURE_MAIL_FOUNDATION.md#exact-owner-decisions-and-next-milestone) and [Git checkpoint review](GIT_CHECKPOINT_REVIEW.md).
