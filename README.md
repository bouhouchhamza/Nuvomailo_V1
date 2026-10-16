# Nuvomailo

Multi-tenant email hosting SaaS under active development. The product is designed for long-term operation: a customer/organization dashboard, modular control plane, asynchronous lifecycle workers, independently operated mail infrastructure, webmail, billing and reliable operations.

**Current status:** control-plane, identity/session/MFA, tenant collaboration, staff operations, sandbox billing and webmail foundations are locally tested. The default mail adapter defers work and webmail/payment/notification providers remain unconfigured. Actual SMTP/IMAP delivery is verified only in the isolated synthetic DMS lab. Production readiness has not been established.

## Implemented locally

An additional **isolated DMS 15.1.0 candidate lab** now exercises real provisioning, runtime quotas/authentication, suspension, recovery and cold restore. It has no published ports, uses separate synthetic data, and requires explicit lab-worker opt-in. The normal SaaS worker stays pending-only. See the [lab runbook](docs/DMS_CONFORMANCE_LAB.md) and [capability/results matrix](docs/DMS_CONFORMANCE_RESULTS.md).

- Argon2id registration/login, persisted revocable sessions, rotating refresh cookies, replay protection, reset/verification grant interfaces and encrypted TOTP/recovery flows. Real identity notifications remain unconfigured.
- Organizations and memberships with owner/admin/member authorization; transactional membership locks for mutations.
- Domain ownership via server-side expiring TXT challenge; ownership and mail readiness remain separate.
- Mailbox configuration, plan-bounded integer quotas and separate desired/observed state. The development plan and DMS conformance adapter still constrain lab quotas to 100/200 MiB.
- Transactional provisioning queue and audit events; separate worker with mailbox ordering, leases, bounded retries, dead letters, stale completion fencing and reconciliation.
- Tenant-scoped queue/audit APIs and React Operations view, alongside organization/domain/member/mailbox/account views.
- Correlated structured HTTP logs and database readiness.
- Verified-member invitations, ownership transfer, leave and retained organization/domain configuration lifecycle.
- Separate persisted staff roles with recent MFA, audited control-plane suspension, plan catalog and controlled failed-job retry.
- Explicit sandbox subscriptions, signed/idempotent test webhooks, immutable checkout quotes, invoices and resource entitlements; no real payments.
- Explicit mailbox read/write assignments and server-side webmail: folders/search/read/attachments/flags/Trash/send/drafts/replies, tested against synthetic IMAP/SMTP. See [webmail security and evidence](docs/WEBMAIL_FOUNDATION.md).

Real credential provisioning, public deliverability, merchant billing, notification delivery, coordinated encrypted off-host recovery, aliases/forwarding, complete mailbox lifecycle, production deployment and independent security validation remain unfinished or infrastructure-dependent. See [implementation progress](docs/MASTER_IMPLEMENTATION_PROGRESS.md) and [full product roadmap](docs/PRODUCT_ROADMAP.md).

## Run locally

Requirements: Node.js 24, npm, Docker Compose and local PostgreSQL 17. Preserve existing `.env` files and volumes.

```powershell
npm --prefix backend ci
npm --prefix frontend ci
if (!(Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
if (!(Test-Path infrastructure/.env)) { Copy-Item infrastructure/.env.example infrastructure/.env }
```

For a new checkout, set matching local DB credentials in the two environment files. Infrastructure uses `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`; backend uses `PGUSER`, `PGPASSWORD`, `PGDATABASE`, host `127.0.0.1`, port `55433`. Do not change existing database credentials merely to match examples. JWT secret is optional only in development (random per-process fallback); production requires at least 32 characters.

```powershell
docker compose --env-file infrastructure/.env -f infrastructure/compose.yaml up -d db
npm --prefix backend run migrate -- up
npm run dev:backend
```

In a second root terminal:

```powershell
npm run dev:frontend
```

Open **http://localhost:5173**. Vite proxies `/api` to the loopback API at `127.0.0.1:4000`. Access tokens last 15 minutes and remain in memory; the HttpOnly rotating refresh cookie restores a persisted session on reload. Production requires stable signing and approved encryption-key custody. Local MFA requires an explicitly configured identity encryption key; no real key is generated automatically.

Optional third terminal starts the **development pending adapter only**:

```powershell
npm --prefix backend run worker
# Or one tick for local troubleshooting:
npm --prefix backend run worker -- --once
```

Worker deferrals are expected, retain pending state and do not consume attempts. Nothing starts Docker Mailserver or sends mail. Startup/scheduling/failure recovery is described in the [worker runbook](docs/OPERATIONS.md).

```powershell
npm run typecheck
npm test
npm run build
```

Tests use synthetic records in the configured local database and a random temporary schema for migration/backfill/rollback checks. Never run these against production. Frontend tests use jsdom/stubbed HTTP; worker successful provider observations use an in-memory test fixture. See [verification evidence](docs/VERIFICATION.md).

## Architecture and product documentation

- [Actual and target architecture, audit, risks and component evaluation](docs/ARCHITECTURE.md)
- [Complete product scope, dependencies and milestone acceptance](docs/PRODUCT_ROADMAP.md)
- [Architecture decisions and tradeoffs](docs/ARCHITECTURE_DECISIONS.md)
- [Implemented API](docs/API_IMPLEMENTED.md)
- [Database model and migration notes](docs/DATABASE.md)
- [Worker operations and recovery boundaries](docs/OPERATIONS.md)
- [Next mail-integration proposal and decision gates](docs/MAIL_INTEGRATION_PROPOSAL.md)
- [Security requirements and remaining gates](docs/SECURITY.md)

Historical phase handoff and demonstration planning remain in `docs/PHASES_1_5_HANDOFF.md`, `docs/ROADMAP.md`, `docs/REQUIREMENTS.md`, and `docs/history/README_PHASES_1_5.md`. They are snapshots, not current product scope. The small development VPS is a testing environment; capacity and recovery require measurements before production selection.
