-- Apply after migrations, as dedicated schema owner. Never use the owner for runtime.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nuvomailo_api,nuvomailo_worker,nuvomailo_notification;
GRANT SELECT,INSERT,UPDATE ON users,organizations,memberships,domains,mailboxes,provisioning_requests,
identity_sessions,refresh_tokens,identity_grants,mfa_recovery_codes,membership_invitations,
plans,organization_subscriptions,billing_checkouts,billing_webhook_events,invoices,mailbox_access,mail_routes
TO nuvomailo_api;
GRANT SELECT,INSERT,UPDATE ON mailbox_usage_requests TO nuvomailo_api;
GRANT SELECT ON organization_usage_rollups TO nuvomailo_api;
GRANT SELECT ON billing_renewal_requests TO nuvomailo_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON webmail_contacts TO nuvomailo_api;
GRANT SELECT,INSERT,UPDATE ON webmail_send_attempts TO nuvomailo_api;
GRANT SELECT ON domain_revalidation_requests,domain_notification_outbox TO nuvomailo_api;
GRANT SELECT,INSERT ON released_domain_claims TO nuvomailo_api;
GRANT DELETE ON domains TO nuvomailo_api;
GRANT DELETE ON memberships,refresh_tokens,mfa_recovery_codes,mailbox_access TO nuvomailo_api;
GRANT SELECT,INSERT ON audit_events,security_events,platform_events,mail_routing_requests TO nuvomailo_api;
GRANT SELECT ON platform_staff,mailbox_credential_requests TO nuvomailo_api;
GRANT SELECT,INSERT,UPDATE ON support_grants TO nuvomailo_api;
GRANT SELECT,INSERT,UPDATE ON platform_incidents TO nuvomailo_api;
GRANT SELECT,INSERT ON platform_alert_outbox TO nuvomailo_api;
GRANT SELECT,INSERT,UPDATE ON platform_heartbeats TO nuvomailo_api;
GRANT SELECT,UPDATE ON mailbox_credential_grants TO nuvomailo_api;
GRANT USAGE,SELECT ON SEQUENCE audit_events_id_seq,security_events_id_seq,platform_events_id_seq TO nuvomailo_api;
GRANT SELECT ON organizations,domains,mailboxes,provisioning_requests,plans,organization_subscriptions,billing_checkouts TO nuvomailo_worker;
GRANT SELECT,INSERT,UPDATE ON mailbox_usage_requests TO nuvomailo_worker;
GRANT SELECT,INSERT,UPDATE ON organization_usage_rollups TO nuvomailo_worker;
GRANT SELECT,INSERT,UPDATE ON billing_renewal_requests TO nuvomailo_worker;
GRANT SELECT,INSERT ON synthetic_billing_renewal_effects TO nuvomailo_worker;
GRANT INSERT,UPDATE ON provisioning_requests TO nuvomailo_worker;
GRANT UPDATE ON mailboxes,organization_subscriptions,billing_checkouts TO nuvomailo_worker;
GRANT INSERT ON invoices TO nuvomailo_worker;
GRANT INSERT ON audit_events TO nuvomailo_worker;
GRANT SELECT,INSERT,UPDATE ON platform_heartbeats TO nuvomailo_worker;
GRANT USAGE,SELECT ON SEQUENCE audit_events_id_seq TO nuvomailo_worker;
GRANT SELECT ON organizations,domains,memberships,mailboxes TO nuvomailo_notification;
GRANT SELECT(id,email,status,email_verified_at) ON users TO nuvomailo_notification;
GRANT SELECT,INSERT,UPDATE ON domain_revalidation_requests,domain_notification_outbox TO nuvomailo_notification;
GRANT SELECT,INSERT ON synthetic_notification_deliveries TO nuvomailo_notification;
GRANT SELECT ON platform_incidents TO nuvomailo_notification;
GRANT SELECT,UPDATE ON platform_alert_outbox TO nuvomailo_notification;
GRANT INSERT ON synthetic_alert_deliveries TO nuvomailo_notification;
GRANT SELECT,INSERT,UPDATE ON platform_heartbeats TO nuvomailo_notification;
GRANT INSERT ON provisioning_requests TO nuvomailo_notification;
GRANT UPDATE(desired_status,desired_inbound_policy,desired_revision,provisioning_status,
  last_provisioning_error,updated_at) ON mailboxes TO nuvomailo_notification;
GRANT UPDATE(revalidation_state,ownership_revalidated_at,revalidation_due_at,revalidation_last_attempt_at,
  revalidation_failures,revalidation_grace_expires_at,revalidation_revision,verification_status,mail_activation)
  ON domains TO nuvomailo_notification;
GRANT INSERT ON audit_events TO nuvomailo_notification;
GRANT USAGE,SELECT ON SEQUENCE audit_events_id_seq TO nuvomailo_notification;
-- Ordinary worker has no grants on users, sessions/MFA, credentials/artifacts, staff roles or notification queues.
-- Real credential/routing provider identities require a separately reviewed rollout.
