# Proposed API contract · Nuvomailo

> **Status:** Draft, not yet implemented · **Prefix:** `/api/v1`  
> **Transport:** HTTPS in deployed environments · **Payloads:** JSON

## Conventions

- Authentication is mandatory for all tenant administration endpoints.
- An actor's authorized organizations are resolved **server-side**.
- Unknown and unauthorized resources may return `404` rather than reveal their existence.
- All create/update endpoints have validation and audit rules.
- Correlation IDs should appear in logs and recoverable error responses; never expose secrets or stack traces publicly.

## Endpoint inventory

| Method | Route | Meaning | Status |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Process liveness | Planned |
| `POST` | `/auth/login` | Start dashboard session | Planned |
| `POST` | `/auth/logout` | End dashboard session | Planned |
| `GET` | `/me` | Current dashboard identity | Planned |
| `GET` | `/organizations` | My organizations only | Planned |
| `GET` | `/organizations/:orgId` | Read authorized organization | Planned |
| `PATCH` | `/organizations/:orgId` | Edit org (role-restricted) | Planned |
| `POST` | `/organizations/:orgId/domains` | Register domain challenge | Planned |
| `POST` | `/organizations/:orgId/domains/:domainId/verify` | Server-side DNS TXT lookup | Planned |
| `GET` | `/organizations/:orgId/domains` | List verified/pending domains | Planned |
| `POST` | `/organizations/:orgId/mailboxes` | Request mailbox provisioning | Planned |
| `GET` | `/organizations/:orgId/mailboxes` | List mailboxes with state/quota | Planned |
| `GET` | `/organizations/:orgId/mailboxes/:mailboxId` | Read mailbox metadata | Planned |

This design intentionally does not expose raw SMTP/IMAP through Express endpoints.

## Mailbox request example

```http
POST /api/v1/organizations/17d8.../mailboxes
Content-Type: application/json
```

```json
{
  "domainId": "e1f4...",
  "localPart": "student",
  "quotaMb": 100
}
```

**Illustrative success:** `202 Accepted`

```json
{
  "data": {
    "id": "8eb0...",
    "address": "student@school.example",
    "quotaMb": 100,
    "provisioningStatus": "PENDING"
  }
}
```

No plaintext mailbox password appears in responses or database job payloads. A secure onboarding or secret-delivery flow is an **open implementation decision**.

## Error shape (draft)

```json
{
  "error": {
    "code": "DOMAIN_NOT_VERIFIED",
    "message": "This domain has not completed ownership verification.",
    "requestId": "req_..."
  }
}
```

| HTTP | Example use |
| :--- | :--- |
| `400` | Invalid syntax / malformed input |
| `401` | Not authenticated |
| `403` | Authenticated but missing required permission |
| `404` | Resource not found / not disclosed |
| `409` | Conflicting domain or mailbox |
| `422` | Valid shape, disallowed business rule |
| `202` | Provisioning accepted but not yet completed |
| `429` | Request rate limited |
| `500` | Unexpected internal failure; generic public message |

> [!NOTE]
> This document is a **contract proposal**, not evidence these endpoints exist. Add OpenAPI and contract tests once the first routes are implemented.
