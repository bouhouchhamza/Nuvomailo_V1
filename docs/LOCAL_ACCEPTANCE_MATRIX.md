# Local acceptance and production gaps

Updated16 October2026. The master ledger records exact executed commands and counts. This matrix distinguishes engineering still possible locally from owner-approved external prerequisites; no row constitutes production acceptance.

| Area | Verified local evidence | Remaining local engineering | External/owner gate |
| --- | --- | --- | --- |
| Application upgrade | Old/current images each pass13 HTTP checks on an isolated copy of schema4761; send records preserved | Repeat container rollback using restricted runtime roles; reapply migrations/grants during full rollout | Release policy, deployment identity, independent review |
| Database roles | Restricted API can preserve/update reconciliation; worker cannot read/write it; migration reapplication preserves populated data | Container-role rollback and pooled-connection privilege tests | Production credential custody/rotation |
| Restore | Signed/encrypted162-file populated snapshot; credential and generation/replay checks | Cold boot of newest12cbb336 snapshot; actual provisioning convergence on restored mail | Off-host storage, KMS/key custody, retention, measured RPO/RTO |
| Provisioning | DB-backed expired-lease recovery, stable-key effect replay, stale acknowledgement rejection, remote-newer revision protection | Mismatched DB/mail restore reconciliation and operator recovery workflow | Mail-node topology, independently confined helper |
| SMTP/DSN | Real loopback RCPT450/550/partial acceptance, no DATA on total rejection, ambiguous disconnect; MIME delayed/failed reports | DMS queue retry/expiry, actual DSN generation/correlation, scanning/filtering and sustained workload | Public delivery, IP/PTR/DNS/TLS, reputation/abuse policy |
| Webmail | Private drafts, contacts, bounded threading, send ledger/reconciliation, eight Chromium checks | Mailbox-wide index, uncertainty identification UX, scanning integration, full accessibility and distributed-session controls | Production auth/certificate/secret design |
| Alerts/monitoring | Durable synthetic outbox, retry/replay and heartbeat freshness | Queue-age/observation-to-incident policy, maintenance windows, sustained monitoring tests | Real destinations, escalation, on-call/SLO ownership |
| Billing | Synthetic checkout/webhook/renewal fencing, mail preservation, non-billable usage rollups | Broader renewal/dunning/reconciliation coverage and immutable period metering | Merchant/tax provider, pricing, dispute and commercial policy |
| Lifecycle/security | Tenant isolation, revalidation/custody, empty-domain release, reversible retention | Import/migration/forwarding/purge policies and distributed abuse controls | Legal retention/privacy decisions; authorization before irreversible deletion |

Current resource gate: avoid scanner startup, sustained load, extra full snapshots and Docker image builds while host memory remains near1GiB and disk near7GiB. Inspect resources before each infrastructure run. Never free space by deleting protected evidence/volumes or killing unrelated applications.

SMTP acceptance is not delivery confirmation. A delayed DSN is not a failure, a permanent failure for one recipient does not undo acceptance of another, and a missing Sent copy does not prove delivery failed. Current safe behavior retains uncertainty and never automatically resubmits the original send key. Loopback tests do not establish DMS's queue/DSN behavior or production deliverability.
