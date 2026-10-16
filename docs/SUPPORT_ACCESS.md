# Temporary support diagnostics

15 October2026. Local implementation; no staff account or production access enabled.

Verified organization owners may consent to one named existing eligible staff identity for15,30 or60 minutes after dashboard password reauthentication. The persistent dashboard session must be active; an MFA-enabled owner requires MFA within15 minutes. At most20 unexpired grants may remain active per organization. An owner may inspect/revoke grants even while the organization is suspended.

The grant permits only aggregate domain/mailbox/provisioning-state diagnostics through a dedicated endpoint. It provides no tenant impersonation, message contents, member identities, credentials or write operations. Existing independently authorized platform directory/status powers remain governed by staff role; these grants do not replace that policy.

Each read rechecks the assigned staff identity, verified account, active session and recent MFA, grant expiry/revocation, active organization, and the granting user's current verified active owner membership. Losing ownership invalidates the grant immediately. Reads, issuance and revocation write tenant audit events. No bearer grant token or dashboard password is persisted; the UUID is an identifier and does not confer access by itself.

Migration4749 and the reviewed runtime grants add API access to the table; the ordinary worker has no access. Owner controls are in account security, staff diagnostic controls in platform administration. Tests cover wrong actor/session/password, oversized duration, another staff identity, stale MFA, lost ownership, expiry, revocation and suspended-tenant revocation. UI tests cover explicit consent/password clearing, revocation and clearing results after a denied grant.

Remaining: notifications and consent receipts, independent review, incident workflows and policy for staff identity issuance. Production staff onboarding and any broader support scope require owner review; message-content support access is not implemented.
