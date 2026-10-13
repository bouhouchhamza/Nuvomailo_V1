# Security design & pilot gates · Nuvomailo

> **State:** Security requirements defined; not an audit or certification.  
> **Applies to:** React dashboard, Express API, PostgreSQL, provisioning, Docker Mailserver and VPS.

## 1. Threat model (initial)

| Threat | Example | Minimum control |
| :--- | :--- | :--- |
| Broken tenant isolation | Admin of org A requests org B mailbox | Server-side membership + negative authorization tests |
| Credential compromise | Password reuse or leaked token | Strong password hashing, session hardening, MFA plan |
| Mail relay abuse | Unauthorized person sends via server | SMTP authentication, restricted relay, rate policies |
| Privilege escalation | API process controls host Docker socket | Restricted provisioning boundary; no Docker socket in public API |
| Domain hijack | Customer adds domain they do not own | Expiring server-checked DNS TXT proof |
| Data exfiltration | Logs contain secrets or email bodies | Redaction + least-privilege log access |
| Disk exhaustion | Large attachments fill shared 50 GB | Quotas, message limits, alerts and off-server backups |
| Mail spoofing | Messages fail authentication checks | SPF, DKIM, DMARC, PTR validation and monitoring |
| Delivery failure | Legitimate messages land in spam | Testing, sender reputation, feedback and monitoring |

## 2. Mandatory gates before public exposure

### Application

- [ ] Validate all API input at runtime (TypeScript alone is not validation).
- [ ] Authenticate every non-public management route.
- [ ] Authorize **per organization and operation**, not only per role label.
- [ ] Use parameterized SQL / safe query builder; never concatenate user SQL.
- [ ] Rate limit sensitive endpoints and cap request body sizes.
- [ ] Do not leak stack traces, verification tokens or credentials in responses.
- [ ] Choose and document a secure dashboard session model (HttpOnly, Secure, SameSite cookies when applicable; CSRF mitigation if cookie-authenticated).
- [ ] Distinguish admin identities from email mailbox credentials.

### Mail and infrastructure

- [ ] Confirm inbound TCP 25, outbound TCP 25 restrictions and reverse DNS with the provider.
- [ ] Set up and test TLS for SMTP submission and IMAP independently from website HTTPS.
- [ ] Prevent open relay; test unauthenticated submission rejection.
- [ ] Configure SPF, DKIM, DMARC, MX, PTR; verify propagation and external acceptance.
- [ ] Protect SSH with keys; use firewall, least privilege and timely updates.
- [ ] No public PostgreSQL port, Docker daemon API or provisioning administrative endpoint.
- [ ] Restrict the worker's operations to allowlisted mailbox commands and fixed targets.
- [ ] Never place plaintext passwords on command lines, logs or persistent job payloads.
- [ ] Use off-server encrypted backups with verified restore and access controls.

## 3. Tenant-isolation test matrix

| Actor | Action | Expected |
| :--- | :--- | :--- |
| Org A admin | List org A mailboxes | Allowed |
| Org A admin | List org B mailboxes | Denied / no metadata disclosure |
| Org A admin | Create mailbox on org B domain | Denied |
| Org A admin | Delete org B mailbox | Denied |
| Org A member | Edit org A domain | Denied unless explicitly permitted |
| Anonymous | Any organization management route | `401` |
| Org A admin | Register domain already owned by org B | Denied; no cross-tenant assignment |

**Do not** rely on frontend filtering to pass any of these tests.

## 4. Backups and recovery

At least these datasets require a recovery design:

1. PostgreSQL metadata and provisioning job state.
2. Docker Mailserver mailbox data and configuration **including mail account metadata**, stored securely.
3. Runtime configuration and certificate recovery/renewal procedures (never publish private keys).

Minimum pilot test: simulate restoration to a separate test instance, verify database consistency, verify a mailbox can be opened, and document what could not be recovered. Backups stored on the same VPS are **not** sufficient protection against VPS loss.

## 5. Privacy and school readiness

The Sunday demo must use **synthetic accounts and test messages**. Prior to accepting actual school email, obtain organizational authorization and review applicable privacy, retention, data location, access and incident handling requirements. Neither a functioning container nor these documents establish legal or production readiness.

## 6. Security references

- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [Docker Mailserver official docs](https://docker-mailserver.github.io/docker-mailserver/latest/)

## Reporting a security issue

For the private pilot, report suspected vulnerabilities privately to the repository maintainer through a trusted channel. **Do not open a public issue containing secrets, exploitable details or personal data.** A formal disclosure channel will be selected before public launch.
