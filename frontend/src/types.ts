export interface User {
  id: string;
  email: string;
  created_at: string;
}
export type Role = "owner" | "admin" | "member";
export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  created_at: string;
}
export interface Member {
  id: string;
  email: string;
  role: Role;
}
export interface Domain {
  mail_ever_activated?: boolean;
  revalidation_state?: "due" | "current" | "warning" | "failed";
  ownership_revalidated_at?: string | null;
  revalidation_due_at?: string;
  revalidation_failures?: number;
  revalidation_grace_expires_at?: string | null;
  status?: "active" | "suspended" | "retained";
  id: string;
  name: string;
  verification_status: "pending" | "verified" | "failed";
  verification_attempts: number;
  verification_expires_at: string;
  last_attempt_at: string | null;
  dnsChallenge: { type: string; name: string; value: string };
  mailReadiness: "not-configured";
}
export interface Mailbox {
  desired_inbound_policy?: "accept" | "defer";
  observed_inbound_policy?: "unknown" | "accept" | "defer";
  retained_at?: string | null;
  usageState?: "unknown" | "fresh" | "stale";
  usageBytes?: number | null;
  messageCount?: number | null;
  usageObservedAt?: string | null;
  usageLastErrorCode?: string | null;
  usageRefreshAvailable?: boolean;
  desired_status: "active" | "suspended";
  desired_revision: number;
  applied_revision: number;
  observed_status: "unknown" | "absent" | "active" | "suspended";
  observed_quota_mb: number | null;
  observed_at: string | null;
  last_provisioning_error: string | null;
  id: string;
  domain_id: string;
  address: string;
  quota_mb: number;
  provisioning_status:
    "pending_provisioning" | "active" | "failed" | "suspended";
  provisioningMode: "pending-phase-6";
  liveMailAvailable: false;
}
export interface ProvisioningJob {
  id: string;
  mailbox_id: string;
  address: string;
  operation: string;
  revision: number;
  desired_status: "active" | "suspended";
  quota_mb: number;
  state: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  max_attempts: number;
  available_at: string;
  last_error_code: string | null;
  lease_expires_at: string | null;
}
export interface AuditEvent {
  id: string;
  actor_user_id: string | null;
  action: string;
  resource_id: string | null;
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface LoginResponse {
  user: User;
  accessToken: string;
  expiresIn: number;
}
