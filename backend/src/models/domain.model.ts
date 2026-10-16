export interface Domain {
  revalidation_revision?: string | number;
  mail_ever_activated?: boolean;
  revalidation_state?: "due" | "current" | "warning" | "failed";
  ownership_revalidated_at?: Date | null;
  revalidation_due_at?: Date;
  revalidation_last_attempt_at?: Date | null;
  revalidation_failures?: number;
  revalidation_grace_expires_at?: Date | null;
  status: "active" | "suspended" | "retained";
  mail_activation: "disabled" | "local-lab";
  id: string;
  organization_id: string;
  name: string;
  verification_token: string;
  verification_status: "pending" | "verified" | "failed";
  verification_expires_at: Date;
  verification_attempts: number;
  last_attempt_at: Date | null;
  verified_at: Date | null;
  created_at: Date;
}
