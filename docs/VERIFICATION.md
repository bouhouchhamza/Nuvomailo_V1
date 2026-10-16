# Local verification record

## Isolated DMS conformance milestone — 14 October 2026

Executed the digest-pinned DMS 15.1.0 lab through the real provider-specific Unix-socket adapter and separate fixture database. Full primary and cold-restore scripts passed; [scenario matrix](DMS_CONFORMANCE_RESULTS.md) and [machine evidence](reports/dms-conformance-2026-10-14.json) distinguish actual provider outcomes from regression unit/component tests. Regression now passes **10 backend tests, 9 frontend tests**, strict TypeScript and backend/React builds. Five existing migrations independently applied to the lab fixture database; no existing migration/schema or development data was replaced.

Important non-pass finding: raw Node Argon2id encoded hash rejected by pinned Dovecot, while canonical parameter ordering authenticated in the synthetic probe. Auth suspension denied IMAP/SMTP login but still received local mail. Cold restore recovered all 18 messages in its snapshot; latest primary run retained 20. No production readiness claim, credential reuse, published ports, public DNS/VPS, real external email, destructive volume operations, commits or pushes. Lab services stopped and volumes/evidence retained.

## Architecture foundations iteration — 14 October 2026

Baseline reverified before implementation: TypeScript checks, six backend tests, seven frontend tests and healthy existing PostgreSQL 17 Compose container. Current iteration adds full-product architecture/roadmap/decisions and implements M1–M2 foundations; all original functionality remains covered.

| Command / evidence | Current result |
| --- | --- |
| `npm run typecheck` | Pass: strict backend application/tests/migrations and frontend |
| `npm test` | Pass: **9 backend tests, 9 frontend tests**, no failures/skips |
| `npm run build` | Backend emission and React production bundle pass |
| `npm --prefix backend run migrate -- up` | New `1791977444734_durable-provisioning` and `1791977444735_reconciliation-operations` applied locally; subsequent run no-op |
| Isolated migration integration | Five migrations; legacy create/suspend/quota/resume snapshots backfilled correctly; unknown actual observations preserved; repeat up no-op; all five roll back in isolated schema |
| `npm --prefix backend run worker -- --once` | Exit 0, pending adapter mode; no live operations |
| `git diff --check` | Pass; ordinary Windows line-ending notices |

Additional backend coverage: transaction-level revocation locking; rollback of mailbox/request/audit together; demotion during DNS lookup; renewal cannot reset DNS throttling; real foreign-domain ID substitution; concurrent claims/schedulers; desired revision cannot be masked by older completion; retry key stability; bounded/permanent failures and dead-letter blocking; crash-after-effect inspection; expired lease recovery and stale token rejection; adapter timeout; manual/scheduled drift reconciliation; queue/audit access and pagination; readiness and generated correlation IDs; logging excludes bodies/query/path identifiers/bearer secrets; raw provider error text is never persisted. Successful mail adapters exist **only as in-memory test fixtures**.

Additional frontend coverage: Operations queue/dead-letter/audit view and retry submission; members cannot see admin Operations navigation; pending suspension offers resume based on desired state, with unknown actual state clearly shown. Tests remain jsdom/stubbed HTTP, not live browser/mail infrastructure evidence.

Milestones M0–M2 are tested locally with pending/default infrastructure. Nothing is declared commercially production-ready. Real mail/credentials, SMTP/IMAP/DNS/deliverability, platform admin, webmail, entitlements/billing, central metrics/alerts, measured capacity, backups/restores and security review remain open in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md). The next operational decision is prepared in [MAIL_INTEGRATION_PROPOSAL.md](MAIL_INTEGRATION_PROPOSAL.md).

The worktree still contains the owner's original uncommitted implementation. Tracked changes now include README, backend packages, architecture/database/requirements/roadmap/security documents. New/untracked files include the existing baseline plus the worker, queue/audit/transaction/service/UI/test additions, two new migrations, architecture decisions, product roadmap, operations/proposal and historical README copy. No commits or pushes; HEAD remains `3d36412`. Real `.env` files stay ignored; no secrets or volumes changed. Existing metadata was retained; test fixtures/temp schemas alone were removed.

## Historical Phases 1–5 verification snapshot

Date: 14 October 2026. Environment: Windows/PowerShell, Node.js 24.15.0, existing healthy PostgreSQL 17 Docker container. No production infrastructure or real DNS records changed.

| Command (repository root unless noted) | Result |
| --- | --- |
| `npm run typecheck` | Backend application, tests and migration TypeScript checks; frontend TypeScript check pass |
| `npm run build` | Backend JavaScript emission and frontend production build pass |
| `npm --prefix backend test` | 6 tests pass, 0 failures/skips |
| `npm --prefix frontend test` | 7 tests pass, 0 failures/skips |
| `npm --prefix backend run migrate -- up` | Both new migrations applied; subsequent run reports no migrations to run |
| Migration integration test | All 3 migrations apply to a fresh isolated schema, repeated up is a no-op, all 3 roll back; synthetic schema removed |
| `npm --prefix backend audit` | 0 reported vulnerabilities |
| `npm --prefix frontend audit` | 0 reported vulnerabilities |
| `git diff --check` | Pass; Git reports normal Windows line-ending conversion notices |
| `git check-ignore backend/.env infrastructure/.env` | Both real environment files remain ignored |

Backend tests execute HTTP requests against Express with real PostgreSQL persistence. DNS success/failure records are supplied by an injected resolver; no live domain ownership or mail readiness is claimed. The expected 500-error test logs a sanitized error name/code. Missing optional development JWT secret prints an ephemeral-key notice.

Frontend tests use React Testing Library, jsdom and stubbed fetch responses. They exercise authentication, registration, empty organization creation, mailbox configuration/quota submission, role-aware controls, pending domain TXT instructions, verified-domain gating, error presentation, expired sessions, validation responses and empty 204 responses. This is not final browser or infrastructure end-to-end validation.

All application builds include strict TypeScript checks. Backend `typecheck` additionally checks test and migration source through `backend/tsconfig.tests.json`.

## Git state

Starting HEAD remains `3d36412` (`chore(backend): setup TypeScript environment`). No commits or pushes were made. The owner's existing uncommitted files were retained.

Tracked modified files:

- `README.md`
- `backend/package.json`
- `backend/package-lock.json`

Untracked paths (some already existed before this task):

- `backend/.env.example`, `backend/migrations.config.mjs`, `backend/migrations/`, `backend/src/`
- `backend/tests/`, `backend/tsconfig.tests.json`
- `docs/API_IMPLEMENTED.md`, `docs/PHASES_1_5_HANDOFF.md`, `docs/VERIFICATION.md`
- `frontend/`, `infrastructure/`, `package.json`, `package-lock.json`

Build output, dependencies and real `.env` files are ignored. Existing data/volumes were preserved; tests removed only their uniquely identified synthetic fixtures.
