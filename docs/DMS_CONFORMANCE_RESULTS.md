# DMS conformance results — 14 October 2026

**Candidate only; production readiness not established.** DMS 15.1.0 at digest `sha256:af51b15dd3fc72153c0e90eb7692bb5e3a463212d87959a80fa7aa89b617d44a`. All listed outcomes were executed locally. The [machine-readable evidence](reports/dms-conformance-2026-10-14.json) preserves the full primary run and an earlier separate cold-restore run. No real domain/credential/external delivery was involved.

## Provider capability and limitation matrix

The later [secure foundation results](SECURE_MAIL_RESULTS.md) record the new full successful run, policy/security checks, corrected watcher race and remaining limits.

**Later secure-foundation iteration:** [current architecture](SECURE_MAIL_FOUNDATION.md) adds independent SMTP inbound deferral, a dedicated listener UID/private lab helper, native hash creation and matching-state remote fencing. The original matrix below remains the initial spike's evidence; receiving no longer has to stay enabled when an explicit lab deferral policy is selected.

| Capability | Actual result | Important limitation |
| --- | --- | --- |
| Create mailbox | Pass: worker created synthetic account via FILE provisioner; independent runtime lookup/auth succeeded | Node-local agent writes documented account hashes; no production onboarding |
| Independent inspect | Pass: effective `doveadm user` quota + Dovecot auth, then TLS IMAP/SMTP probes | Configuration alone insufficient; inconsistent runtime state stays unknown |
| Set quota | Pass: 100/200 MiB transitions observed in effective userdb | Source values can be bytes or binary suffixes; parser corrected during experiment |
| Actual storage enforcement | Pass: first run accepted 12 × 8 MiB appends, next rejected for quota under 100 MiB ceiling | DMS also has separate 10 MB message limit, 10% grace and Trash allowance; not all quota policies exhaustively tested |
| Disable IMAP/SMTP authentication | Pass: synthetic login rejected on both protocols via deny passdb | Not a built-in CLI auth-suspend command; existing SMTP sessions not exhaustively exercised |
| Suspend without mail deletion | Pass: account/hash/mail preserved; subsequent resume/read succeeded | Authentication suspension only; receiving remained allowed |
| Inbound behavior while suspended | Observed: internal SMTP accepted and stored synthetic message while login denied | Production receiving policy must be separate; not a claim that suspension rejects inbound mail |
| Resume | Pass: IMAP + SMTP auth restored, messages retained | Production credential/account lifecycle remains undecided |
| Aliases/collisions | Pass: simple alias created using verified CLI; agent rejected account collision | Nested aliases/catch-all/forwarding abuse not validated |
| Reload | Pass: changedetector regenerated account/quota state, Dovecot reload applied deny policy | File-backed global writer/serialization and convergence delay matter |
| Restart | Pass: actual DMS container restart retained mailbox state and stale-revision rejection | Not failover/multi-node availability proof |
| Backup/restore | Pass: metadata/mail byte comparison; cold boot on separate empty volumes restored auth and all 18 messages in that snapshot | Local unencrypted lab archives; no off-host recovery/PITR/SaaS DB coordinated restore |
| SHA512-CRYPT | Pass: synthetic IMAP + SMTP authentication | Credential bootstrap is lab-only; no plaintext argv/jobs/results |
| Dovecot-generated ARGON2ID | Pass: hash generation and IMAP authentication | Version-specific compatibility evidence |
| SaaS-library Argon2id encoding | **Raw encoded hash rejected**; canonical `m,t,p` ordering authenticated | Installed Node library emits `m,p,t`; production compatibility/import requires separate review and version tests |

## Executed integration/failure checks

1. Real worker creation and independent runtime inspection.
2. Effective quota change and actual aggregate storage rejection.
3. Same idempotency key repeat and simultaneous same-snapshot requests.
4. Stale revision and changed payload under accepted key rejection.
5. Account-before-quota injected failure and idempotent repair. Initial execution created a new account; retained-fixture reruns test the same fault point without deleting it.
6. DMS container restart and preserved runtime/revision state.
7. Effect-before-ack lease recovery; stale PostgreSQL acknowledgement rejected.
8. A worker process applied the effect and deliberately exited **77** before acknowledgement. A separate worker process reclaimed the expired lease and completed the persisted request. Lease expiry was accelerated in the fixture DB.
9. Tenant/org/mailbox/address substitution rejected by independent agent bindings.
10. Unsafe paths, shell-like addresses, real-domain addresses, unknown fields/routes and invalid token rejected.
11. IMAP/SMTP authentication denied while suspended, restored on resume, synthetic data preserved. Receiving during suspension was measured separately.
12. CLI-induced effective quota drift detected and repaired by the normal reconciliation workflow.
13. Acceptance journal persisted before an injected ledger-write failure; stale revisions remained rejected and retry repaired the accepted state.
14. Snapshot restored into fresh directories and then into separate empty cold-boot volumes; TLS auth and stored messages recovered.
15. Lab adapter cannot be constructed into an ordinary worker without explicit opt-in; addresses validated before credential-file access.

These are scenario assertions, not a fabricated count of independent Node test cases. The final automated primary run preserved 20 messages; the earlier cold-restore snapshot contained 18 and restored exactly 18. Re-runs did not delete messages to manufacture a clean mailbox. Raw Node-hash rejection is an explicitly recorded compatibility outcome, not hidden as a pass.

## Commands and regression evidence

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infrastructure/mail-lab/run-conformance.ps1 -ColdRestore
powershell -NoProfile -ExecutionPolicy Bypass -File infrastructure/mail-lab/run-conformance.ps1
npm run typecheck
npm test
npm run build
```

Both conformance runs exited 0 after their asserted scenarios. Cold-restore was exercised on the first full run; additional opt-in/hash/process-exit safeguards were then checked in the latest primary run. Regression: **10 backend tests and 9 frontend tests pass**; strict TypeScript checks pass. Backend/React production builds pass. No existing migration changed; all five are exercised by existing migration/backfill/rollback tests. The lab independently applied those migrations to its own fixture database.

Initially discovered problems were retained as findings and corrected before the final runs: token/deny-file modes under restrictive umask, binary suffix parsing for CLI quotas, and durable fencing across an acceptance-journal/convenience-ledger partial update. The raw Node Argon2 encoding limitation remains documented rather than silently normalized in production code.

## Security, resource and recovery findings

- Observed mail container `privileged=false`, `PortBindings={}`, lab network `internal=true`. Worker has no Docker socket, runs 1000:3000 with read-only root and dropped capabilities. Agent validates socket peer identity, token, schema and independently trusted synthetic mapping.
- No real credential setup. Plaintext synthetic passwords exist only in memory/stdin; account hashes and private seed/token/key material stay in lab volumes. Provisioning metadata/results have no reusable credentials. An argv snapshot found no synthetic plaintext password.
- DMS default failed-auth logs initially exposed truncated SHA1 fingerprints; lab override disables verbose password logging. This is not a full log-forensics/security audit.
- A post-test point sample observed mail ~52 MiB/0.09% CPU/22 processes and fixture DB ~22 MiB/16.59% CPU. Final machine evidence includes another resource sample. No peak/soak/filtered-mail benchmark; filtering was disabled and mail container capped at one CPU/1.5 GiB.
- Local snapshot archives contain private synthetic seed/key/hash data and are unencrypted. Byte restoration and one cold boot passed; off-host encrypted backup, coordinated SaaS DB restore, RPO/RTO, mail-node migration and disaster recovery remain untested.
- Both primary and restore lab services were stopped, volumes retained. Existing development PostgreSQL remained separate and untouched. No volume prune/reset, public DNS/VPS changes, real external email, commits or pushes.
- Final cleanup identified a forced stop under Docker's default timeout. Both Compose definitions now allow 60 seconds. A subsequent fully started node authenticated on IMAP/SMTP, reported `auth_verbose_passwords = no`, and stopped with exit **0**, `OOMKilled=false`. The earlier timeout is not presented as a graceful shutdown success.

## Implemented files and Git state

- `infrastructure/mail-lab/compose.yaml`, `restore.compose.yaml`, `Worker.Dockerfile`, `bindings.json`, `seed.sql`, `user-patches.sh`: separate pinned primary/restore environments and trusted fixtures.
- `infrastructure/mail-lab/agent/{agent,bootstrap,common,configure,probe,restore}.py`: restricted management, durable fencing, synthetic hashing, runtime/protocol/failure/backup/restore probes.
- `infrastructure/mail-lab/run-conformance.ps1`, `argon-compatibility.mjs`: fail-fast operator harness and separate encoded-hash compatibility experiment.
- `backend/src/adapters/dms-lab.adapter.ts`, `backend/src/mail-lab/{client,conformance,rpc}.ts`: typed lab adapter, actual worker/queue integration and negative/concurrency scenarios.
- `backend/tests/dms-lab.test.ts`, adapter-mode/worker opt-in contract, `.dockerignore`, `.gitignore`, architecture/roadmap/runbook/evidence updates.

HEAD remains `3d36412`, with no commits or pushes. Pre-existing modified backend package files and broad untracked source/frontend/infrastructure work remain intact. Tracked dirty paths include `.gitignore`, README, backend package files and existing architecture/database/requirements/roadmap/security docs; new lab/adapter/test/documentation/evidence files are untracked alongside the pre-existing untracked implementation. Real environment files and raw runtime result directories remain ignored. No existing `.env`, migration, Docker volume or development metadata was overwritten.

## Next decision

DMS remains viable for **further controlled evaluation**, not production selection. Review the private agent's privileged node scope, production credential scheme/one-time setup, authentication-vs-receiving suspension policy, runtime DB/transport grants, journal lifecycle, filtering capacity and backup design. Compare Stalwart/mailcow using the same evidence requirements before choosing a final topology. See [lab design/runbook](DMS_CONFORMANCE_LAB.md) and [architecture decisions](ARCHITECTURE_DECISIONS.md).
