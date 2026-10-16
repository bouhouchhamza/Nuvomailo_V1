# Implemented API (Phases 1–5)

## Current additions: architectural foundations

Later implemented additions supersede the phase snapshot: persisted identity sessions/rotation/revocation, password/reset/verification grant interfaces, encrypted standard TOTP/recovery, invitations/transfer/leave, domain health/lifecycle, sandbox billing/entitlements and independently authorized staff operations. Real notification/payment providers remain unconfigured. See current source contracts and [implementation ledger](MASTER_IMPLEMENTATION_PROGRESS.md).

Staff `/api/platform` now includes GET plans/access/directory/detail/queue/audit and operator-only PUT plans, audited status changes and POST queue retry, all requiring persisted staff role/recent MFA. Tenant ownership grants no staff privilege. Owner-only `PUT /api/organizations/:orgId/mailboxes/:mailboxId/access` grants verified members explicit read/write access or revokes it.

Webmail `/api/webmail`: GET available assignments; POST connect/disconnect; GET/POST folders; GET messages/message/attachment; POST message flags or retained Trash move; POST send/draft. Persistent dashboard authentication and explicit mailbox assignment are required. Mailbox cookie is HttpOnly, user/session-bound and expires after15 minutes. Mutations require `X-Nuvomailo-CSRF: 1`; foreign/cross-site origins are rejected. Mail session expiry returns409 requiring reconnection, separate from dashboard401. Attachments force octet-stream. Default provider is unconfigured; only trusted synthetic lab injection exists. See [webmail boundary and actual evidence](WEBMAIL_FOUNDATION.md).

The following supersede the earlier pending-adapter description where it differs. API services now only persist intent/jobs/audit; a separate worker invokes adapters. Runtime mail remains pending/unavailable.

| Method | Path under `/api` | Access / semantics |
| --- | --- | --- |
| GET | `/ready` | Public database connectivity status; `mailReady:false`, 503 when DB unavailable |
| GET | `/organizations/:orgId/provisioning-requests` | Admin/owner; safe request fields, no lease token/provider raw error |
| GET | `/organizations/:orgId/audit-events` | Admin/owner; tenant-scoped immutable application audit |
| POST | `/organizations/:orgId/provisioning-requests/:requestId/retry` | Admin/owner; 202 for dead-letter retry; preserves revision/key; 409 for nonfailed request |
| POST | `/organizations/:orgId/mailboxes/:mailboxId/reconcile` | Admin/owner; 202 queues fresh desired snapshot; 409 while outstanding requests exist |

Operational list shape: `{items: [...], nextCursor: string|null}`. `limit` defaults to 50, allowed 1–100; use returned cursor as `before`. Request cursor is UUID (creation-time/ID keyset), audit cursor is decimal ID. Foreign tenant cursors disclose no rows. Audit events include actor (null for worker), action, resource, safe metadata and timestamp. Job fields include operation, target state/quota, revision, attempts/budget, safe error, next eligible time and lease expiry.

Mailbox responses additionally include `desired_status`, `desired_revision`, `applied_revision`, `observed_status`, `observed_quota_mb`, `observed_at`, `last_provisioning_error`. Existing `quota_mb` remains desired quota. `provisioning_status` is queue/convergence status; it is not a replacement for desired/actual state. A pending suspension can be resumed based on desired state without falsely claiming infrastructure suspension. HTTP responses include a server-generated `X-Request-Id`. Renewed domain challenges retain DNS-attempt throttling.

Tenant mutations authorize inside their resource/job/audit transaction. Membership removal/demotion waits for already-admitted writes; DNS results reauthorize after lookup. Current adapters never establish live mail, and `liveMailAvailable` remains false.

## Preserved initial API inventory

Base path: `/api` (the older `/api/v1` document remains a proposal).
JSON bodies and responses. Protected endpoints use `Authorization: Bearer <accessToken>`.
Errors: `{ "error": "Public message", "issues"?: [{ "path": [], "message": "..." }] }`.

| Method | Path | Body / result | Access |
| --- | --- | --- | --- |
| GET | `/health` | Process health and pending mail mode | Public |
| POST | `/auth/register` | `{email,password}` → `{message,id,email}`, 201 | Public, rate limited |
| POST | `/auth/login` | `{email,password}` → `{user,accessToken,expiresIn:900}` | Public, rate limited |
| GET | `/auth/me` | Sanitized current user | Authenticated |
| GET | `/organizations` | Array of user's organizations with `role` | Authenticated |
| POST | `/organizations` | `{name,slug}` → organization, 201 | Authenticated, becomes owner |
| GET | `/organizations/:orgId` | Organization with current role | Member+ |
| PATCH | `/organizations/:orgId` | `{name}` → updated organization | Admin+ |
| GET | `/organizations/:orgId/members` | Array `{id,email,role,created_at}` | Member+ |
| POST | `/organizations/:orgId/members` | `{email,role:"admin"\|"member"}` → membership, 201 | Owner |
| PATCH | `/organizations/:orgId/members/:userId` | `{role:"admin"\|"member"}` | Owner, target not owner |
| DELETE | `/organizations/:orgId/members/:userId` | 204 | Owner, target not owner |
| GET | `/organizations/:orgId/domains` | Array of domains/challenges | Member+ |
| POST | `/organizations/:orgId/domains` | `{name}` → pending domain, 201 | Admin+ |
| POST | `/organizations/:orgId/domains/:domainId/verify` | Server-side TXT verification → domain | Admin+ |
| POST | `/organizations/:orgId/domains/:domainId/challenge` | Rotate expired/unverified challenge → domain | Admin+ |
| GET | `/organizations/:orgId/mailboxes` | Array of mailbox configurations | Member+ |
| GET | `/organizations/:orgId/mailboxes/:mailboxId` | Scoped mailbox | Member+ |
| POST | `/organizations/:orgId/mailboxes` | `{domainId,localPart,quotaMb?:100\|200}` → mailbox, 202 | Admin+, verified owned domain |
| PATCH | `/organizations/:orgId/mailboxes/:mailboxId` | `{quotaMb:100\|200}` or `{action:"suspend"\|"resume"}` → mailbox, 202 | Admin+, verified owned domain |

Non-members receive 404 for organization-scoped routes; authenticated members with insufficient role receive 403. Invalid inputs return 400, invalid credentials/tokens 401, duplicates 409, unverified domain mailbox requests 422, throttling 429, transient DNS failures 503, unexpected failures sanitized 500.

Passwords are 12–128 characters at registration. Login accepts up to 128 characters. Emails are trimmed/lowercased. Domain names are normalized to lowercase ASCII/IDNA and must use valid DNS labels. Mailbox local parts use lowercase letters/digits with single internal dots, underscores or hyphens (maximum 64 characters). Unknown mailbox fields, including passwords and client-provided provisioning state, are rejected.

Domains expose `dnsChallenge: {type:"TXT",name:"_nuvomailo-verification.<domain>",value:"nuvomailo-verification=<token>"}`, `verification_status`, `verification_attempts`, expiry and attempt timestamps. TXT chunks are joined per record and matched exactly. Challenges expire after seven days; DNS checks are separated by at least 60 seconds and track failed attempts. Mail readiness remains `not-configured`.

Mailboxes expose `address`, `quota_mb`, `provisioning_status`, `provisioningMode:"pending-phase-6"`, and `liveMailAvailable:false`. No request can force `active`. Quota, suspension and resume requests enqueue configuration work; they do not perform mail operations. There is no mailbox password API, no live usage API and no server-side logout/revocation endpoint.
