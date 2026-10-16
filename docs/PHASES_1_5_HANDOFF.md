# Phases 1–5 implementation and handoff

> Historical baseline snapshot. Subsequent architecture foundations add a separate worker, richer adapter contract, observed state, transactional tenant/audit boundaries and operations UI. Use [README](../README.md), [architecture](ARCHITECTURE.md), [operations](OPERATIONS.md) and [current verification](VERIFICATION.md) for the current implementation. Original phase limits below do not limit full product scope.

Implemented locally on 14 October 2026. Phases 6 and 7 are intentionally not implemented.

## Completed

1. **Authentication:** Argon2id registration and password verification, normalized unique emails, 15-minute HS256 JWTs with issuer/audience/algorithm validation, protected `/api/auth/me`, bounded JSON bodies, Helmet, origin-restricted CORS, authentication rate limiting, environment validation, and centralized sanitized errors. Password hashes never appear in API responses.
2. **Organizations:** transactional organization + owner creation, organization selection/list/detail/name updates, memberships and owner/admin/member authorization. Every tenant service checks membership; domain/mailbox queries also scope records by organization. Owners can add existing registered users, change admin/member roles, and remove non-owners. Owners cannot be removed or demoted. Admins manage organization names, domains and mailbox configuration; members have read access.
3. **Domains:** canonical lowercase/IDNA names, global uniqueness, random 256-bit TXT challenges, seven-day challenge expiry and renewal, server-side TXT lookup with timeout/retries, attempt counters and atomic 60-second attempt throttling. Verified ownership is separate from mail readiness. No DNS records are modified by this application.
4. **Mailboxes:** address validation, per-domain address uniqueness, verified owned domain gate, 100/200 MB quotas, lifecycle schema, scoped list/detail/create/update APIs, and transactional provisioning requests. No mailbox password is accepted or stored. Development provisioning always stays pending.
5. **Dashboard:** React + strict TypeScript, central typed API/auth state, registration/login, organization creation/selection/overview, membership management, domains/challenges, mailboxes/quotas, and account profile. Responsive layout, loading/empty/error states, role-aware controls and explicit pending mail notices. No fabricated customer data.

## Local startup (PowerShell)

Run from the repository root. Preserve existing `.env` files.

```powershell
npm --prefix backend ci
npm --prefix frontend ci
# Only for a new checkout: copy examples if the destination does not exist.
if (!(Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
if (!(Test-Path infrastructure/.env)) { Copy-Item infrastructure/.env.example infrastructure/.env }
```

Fill the local database credentials in both files so they match. Infrastructure uses `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`; backend uses `PGUSER`, `PGPASSWORD`, `PGDATABASE`. Database listens on `127.0.0.1:55433`. Do not change existing database credentials/volumes merely to match an example.

```powershell
docker compose --env-file infrastructure/.env -f infrastructure/compose.yaml up -d db
Push-Location backend
npm run migrate -- up
Pop-Location
npm run dev:backend
```

In a second terminal at the root:

```powershell
npm run dev:frontend
```

Open **http://localhost:5173**. Vite proxies `/api` to the API at `http://127.0.0.1:4000`. Use localhost for the frontend to match the default allowed origin. The API binds only to loopback for local development. No mailserver starts.

Optional local `JWT_SECRET` must contain at least 32 characters; production requires it. Without it, development uses a process-local random secret, prints a notice and invalidates tokens on restart. `FRONTEND_ORIGIN` defaults to `http://localhost:5173`; `PORT` defaults to 4000. Required PostgreSQL values are validated at startup. Secrets remain in ignored `.env` files.

## Verification commands and coverage

```powershell
npm run typecheck
npm run build
npm test
```

Backend tests use the configured local PostgreSQL database, create unique synthetic records, and remove only their own records. Run migrations first; do not point these tests at production. Frontend tests run in jsdom and stub HTTP responses; they are not infrastructure/browser end-to-end tests.

- Backend: registration, password login, duplicate email, malformed/invalid input, missing/tampered authentication, sanitized 500, oversized requests, auth rate limiting, organization visibility and role restrictions, protected owner, membership revocation, DNS challenge renewal/verification/throttling, quota rules, verified-domain gating, mailbox tenant restrictions, and persisted pending provisioning requests.
- Migration test: fresh isolated schema application, idempotent re-run and rollback of all three migrations. The randomly named test schema is removed after the test.
- Frontend: sign-in/sign-out, registration, empty organization creation, loading API-backed data, member read-only controls, mailbox creation/quotas/pending status, API errors, expired-token handling, and 204/validation response handling.

See `docs/VERIFICATION.md` for the recorded results of the completed run.

## Important implementation files

- `backend/src/config/env.ts`, `middlewares/auth.ts`, `middlewares/errors.ts`: configuration, tokens and errors.
- `backend/src/services/{auth,tenant,domain,mailbox}.service.ts`: business rules and authorization.
- `backend/src/repositories/{user,organization,tenant,domain,mailbox}.repository.ts`: parameterized persistence and transactions.
- `backend/src/controllers/` and `routes/`: HTTP endpoints.
- `backend/src/services/provisioning.adapter.ts`: Phase 6 interface and pending implementation.
- `backend/tests/`: PostgreSQL-backed API tests and error-handler tests.
- `frontend/src/{api.ts,auth.tsx,app.tsx,types.ts,styles.css,pages/}`: dashboard.
- `frontend/src/app.test.tsx`: UI/API client tests.

## Migrations

The existing `1791977444731_initial-saas-schema.ts` is preserved. Added:

- `1791977444732_domains.ts`: tenant-owned unique domains, ownership challenge/status/expiry/attempt fields and tenant index.
- `1791977444733_mailboxes.ts`: mailboxes, quota/status constraints, unique `(domain_id,local_part)`, and durable provisioning requests.

Mailbox addresses derive from immutable domain name + local part rather than redundant address text. Domain deletion is restricted while mailboxes exist. There is no destructive delete API for domains or organizations in this scope.

## Phase 6 integration contract

`backend/src/services/provisioning.adapter.ts` exports:

```typescript
interface ProvisioningRequest {
  id: string;
  mailbox_id: string;
  operation: 'create' | 'set_quota' | 'suspend' | 'resume';
  quota_mb: 100 | 200;
}
interface MailProvisioningAdapter {
  readonly mode: 'pending-phase-6' | 'live';
  provision(request: ProvisioningRequest): Promise<{
    status: 'pending' | 'completed' | 'failed';
    errorCode?: string;
  }>;
}
```

The API currently persists each request and calls the no-op `PendingProvisioningAdapter`; its result is always pending. Nothing invokes Docker, SMTP or IMAP. `provisioning_requests.id` is the intended idempotency key. Jobs contain no credentials. `quota_mb` is requested configuration, not measured mailbox usage or confirmed applied quota.

Phase 6 checklist:

- Implement a restricted real adapter and a separate worker; do not run mail operations in API/database transactions.
- Claim persisted requests safely, serialize operations per mailbox in creation order, implement retries/backoff, leases/recovery, and idempotency/reconciliation. A worker and these mechanics are not implemented yet.
- Resolve address and tenant using `mailbox_id` joined to `mailboxes` and `domains`; validate domain ownership before provisioning.
- Distinguish desired configuration from last confirmed infrastructure state. Set mailbox `active`/`suspended`/`failed` only after confirmed worker outcomes; mark jobs completed/failed accordingly. Keep newer outstanding requests from being hidden by an older completion.
- Design mailbox credential onboarding/rotation and secure secret delivery without persisting plaintext passwords in metadata/jobs/logs.
- Integrate Docker Mailserver, enforce actual quotas, configure SMTP/IMAP and separately validate mail DNS/deliverability with explicit infrastructure authorization.
- Replace hard-coded pending/live-unavailable API metadata only when real integration supports truthful readiness reporting.

Phase 7 checklist:

- Final security review, authorization/concurrency/resource abuse testing, deployment configuration, durable distributed limiting, TLS and secret lifecycle.
- Infrastructure end-to-end SMTP/IMAP tests, recovery/backups, restore validation, monitoring and deployment/demo.
- Review current permissions, ownership/domain transfer policy, retention/deletion rules, authentication/session requirements and production readiness before real customer use.

## Known limits

- No live mail, usage measurement, mail credentials, mail DNS automation, background worker, SMTP/IMAP, webmail or deliverability claims.
- Sessions last 15 minutes, remain only in memory, and require sign-in after refresh. Logout clears the browser session; an already issued bearer token remains valid until expiry. No refresh tokens/password reset/email confirmation in this scope.
- Authentication limiting uses process memory and is intended for this local single-process setup. Proxy trust is not enabled. Public multi-instance operation requires reviewed proxy/limiter configuration in Phase 7.
- Adding a member does not send email and requires an existing account. No ownership transfer is exposed; the original owner is protected.
- Global pending domain reservations cannot self-service transfer between tenants. Domain verification proves TXT control at the time of verification, not continued ownership or mail readiness. Renewal is for unverified challenges only.
- Lifecycle states are schema-ready; requests deliberately remain `pending_provisioning`. Suspension/resume are queued intentions, not effective infrastructure changes.
- Tests require available local PostgreSQL. Successful DNS cases use an injected resolver and do not constitute proof of configured public DNS. Final browser/infrastructure end-to-end validation belongs to Phase 7.
- No production services, DNS settings, existing secrets, Docker volumes, Git history or remote branches were changed.

## Git handling

The starting worktree contained modified backend package files and untracked backend source/migrations, frontend, infrastructure and root package files. Existing work is preserved. No commit or push was made, to avoid bundling the owner's pre-existing uncommitted implementation into an agent-authored commit. Review and commit the completed worktree as desired; `.env` files remain ignored.
