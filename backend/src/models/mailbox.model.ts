export type MailboxStatus =
  "pending_provisioning" | "active" | "failed" | "suspended";
export interface Mailbox {
  desired_inbound_policy: "accept" | "defer";
  observed_inbound_policy: "unknown" | "accept" | "defer";
  retained_at?: Date | null;
  observed_usage_bytes?: string | number | null;
  observed_message_count?: string | number | null;
  usage_observed_at?: Date | null;
  usage_last_error_code?: string | null;
  mail_activation?: "disabled" | "local-lab";
  desired_status: "active" | "suspended";
  desired_revision: number;
  applied_revision: number;
  observed_status: "unknown" | "absent" | "active" | "suspended";
  observed_quota_mb: number | null;
  observed_at: Date | null;
  last_provisioning_error: string | null;
  id: string;
  domain_id: string;
  local_part: string;
  address: string;
  quota_mb: number;
  provisioning_status: MailboxStatus;
  created_at: Date;
  updated_at: Date;
}
