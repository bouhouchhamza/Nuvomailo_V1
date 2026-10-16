# Historical initial requirements · Nuvomailo

> Full product scope and current milestone acceptance are in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md), with actual boundaries in [ARCHITECTURE.md](ARCHITECTURE.md). This initial demonstration checklist is preserved as history; unchecked items are not a current implementation inventory.

> **Status:** Approved MVP scope, implementation pending · **Target:** 18 October 2026  
> **Audience:** Private demonstration; no production school mail

## Product goal

Provide a simple, secure administration platform where each organization can manage its own verified domains and email accounts without accessing another organization's data. Demonstrate that SMTP/IMAP can work with the configured mail engine.

## Users and roles

| Actor | Goals | Intended rights |
| :--- | :--- | :--- |
| **Platform operator** | Operate pilot services | Infrastructure and emergency controls, auditable |
| **Organization owner** | Manage institution | Domains, admins, mailboxes, policies |
| **Organization admin** | Manage assigned organization | Domains and mailboxes, not other organizations |
| **Organization member** | Use assigned mailbox | No tenant administration unless explicitly delegated |

> Dashboard identity and mailbox identity are different concerns. We must not assume every mailbox automatically grants SaaS admin access.

## Functional requirements

### FR-01 · Organization management — P0

**Story:** As an organization owner/admin, I need to see and manage my own organization's basic settings.

**Acceptance criteria:**

- [ ] Authenticated user sees only organizations where they are a member.
- [ ] Owner/admin may update the organization name; a member without permission may not.
- [ ] A request targeting another organization's ID is rejected with **403 or 404**, without disclosure.
- [ ] The action records an audit event with tenant ID and actor.

### FR-02 · Domain ownership verification — P0

**Story:** As an organization admin, I need to prove ownership of a domain before it is used to create mailboxes.

**Acceptance criteria:**

- [ ] Admin can request registration of a canonical domain (e.g. `school.example`).
- [ ] A random, expiring DNS TXT challenge is issued and displayed.
- [ ] Backend checks TXT DNS data; the UI cannot mark a domain verified.
- [ ] A domain already owned by another organization is rejected.
- [ ] No mailbox provisioning is allowed before `VERIFIED`.

### FR-03 · Mailboxes and quotas — P0

**Story:** As an organization admin, I need to create accounts with a limited capacity.

**Acceptance criteria:**

- [ ] Validated mailbox address belongs to one verified domain of the current tenant.
- [ ] MVP quota must be **100 MB or 200 MB**.
- [ ] Duplicate address requests fail or return the existing result idempotently.
- [ ] Creation returns **202 Accepted** and a `PENDING` status when provisioned asynchronously.
- [ ] A mailbox becomes `ACTIVE` **only after** the mail-server operation succeeds.
- [ ] A failed job is visible and can be safely retried without creating duplicate accounts.

### FR-04 · SMTP and IMAP test — P0

**Story:** As a test user, I want to send and receive email with my provisioned mailbox using a standard mail client.

**Acceptance criteria:**

- [ ] SMTP submission authentication and IMAP login are demonstrated with test credentials.
- [ ] TLS is validated for client connections, using certificates trusted in the target environment.
- [ ] Unauthorized SMTP relay is denied.
- [ ] If public Internet delivery is claimed, external send/receive tests and DNS checks are recorded.
- [ ] Mail delivery failure is reported as a known limitation, never hidden by a successful API response.

### FR-05 · React dashboard — P0

**Story:** As an organization admin, I need one clear interface for managing my organization's email setup.

**Acceptance criteria:**

- [ ] Login/logout flow integrated with the backend.
- [ ] Organization selection shows permitted tenants only.
- [ ] Domain form displays verification instructions and status.
- [ ] Mailboxes list/create flow displays quota and provisioning status.
- [ ] Loading, empty, unauthorized and error states are handled.

## Non-functional requirements

### NFR-01 · Tenant isolation — P0

- [ ] API tests verify tenant A cannot **read, create, modify or delete** tenant B resources.
- [ ] Checks apply regardless of manipulated URL/body IDs.
- [ ] Queries and data model enforce explicit tenant ownership.

### NFR-02 · Authentication & secrets — P0

- [ ] Passwords are stored only as strong hashes; no credentials in source control.
- [ ] Role decisions are made on the server for each protected operation.
- [ ] Input validation, reasonable request limits and generic authentication errors exist.
- [ ] Admin session/auth scheme, cookie/JWT protections and password reset are reviewed before Internet exposure.

### NFR-03 · Observability & recoverability — P0

- [ ] Structured application logging with no passwords, session tokens or raw mail content.
- [ ] Failed provisioning actions generate traceable error codes and audit events.
- [ ] Database + mail data backups have a documented off-server storage location.
- [ ] At least one restore test is performed and recorded before calling the pilot reliable.

## Explicitly out of scope for Sunday

- Public self-registration and billing.
- Full custom React inbox / full webmail implementation.
- Production migration of school MX records or real student data.
- Multi-server HA, automatic failover and guaranteed service-level agreements.
- Enterprise-grade data retention and legal compliance certification.

## Demo definition of done

1. Two test organizations with isolated dashboards and API results.
2. A domain ownership flow, or a documented mock/staging DNS setup clearly labelled as such.
3. A mailbox creation operation with tracked provisioning state.
4. A test SMTP/IMAP scenario with captured evidence.
5. Negative authorization tests and a recovery smoke test.
6. README and known limitations updated honestly.

> [!WARNING]
> If environment issues block a P0 item, mark it **blocked/incomplete** and show a transparent demo of the completed pieces. Never weaken authentication, DNS ownership controls or provisioning isolation merely to finish a deadline.
