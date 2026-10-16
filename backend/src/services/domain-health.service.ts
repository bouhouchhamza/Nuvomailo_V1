import { Resolver } from "node:dns/promises";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { requireTenant, tenantWrite } from "./tenant-context.js";
import * as domains from "../repositories/domain.repository.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
export interface DnsDiagnosticsResolver {
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  txt(name: string): Promise<string[][]>;
}
export const systemDns: DnsDiagnosticsResolver = {
  mx: (name) => new Resolver({ timeout: 3000, tries: 2 }).resolveMx(name),
  txt: (name) => new Resolver({ timeout: 3000, tries: 2 }).resolveTxt(name),
};
async function lookup<T>(run: () => Promise<T>) {
  try {
    return { records: await run(), error: null };
  } catch {
    return { records: null, error: "DNS_LOOKUP_FAILED" };
  }
}
export async function health(
  actor: string,
  org: string,
  id: string,
  resolver = systemDns,
) {
  await requireTenant(actor, org);
  z.uuid().parse(id);
  const domain = await domains.get(org, id);
  if (!domain) throw new HttpError(404, "Domain not found");
  const [mx, txt, dmarc, dkim] = await Promise.all([
    lookup(() => resolver.mx(domain.name)),
    lookup(() => resolver.txt(domain.name)),
    lookup(() => resolver.txt("_dmarc." + domain.name)),
    lookup(() => resolver.txt("mail._domainkey." + domain.name)),
  ]);
  const spf =
    txt.records
      ?.map((record) => record.join(""))
      .filter((record) => /^v=spf1(?:\s|$)/i.test(record)) ?? [];
  const dmarcRecords =
    dmarc.records
      ?.map((record) => record.join(""))
      .filter((record) => /^v=DMARC1;/i.test(record)) ?? [];
  return {
    domain: domain.name,
    ownershipVerified: domain.verification_status === "verified",
    mx,
    spf: { records: spf, singleRecord: spf.length === 1, error: txt.error },
    dmarc: {
      records: dmarcRecords,
      singleRecord: dmarcRecords.length === 1,
      error: dmarc.error,
    },
    dkim: { selector: "mail", ...dkim },
    guidance: {
      mx: "Use the hostname assigned to your approved mail node; none is assigned here.",
      spf: "Authorize only approved senders; this diagnostic does not evaluate SPF.",
      dkim: "Selector mail is a diagnostic default. Publish only the actual node public key.",
      dmarc:
        "Choose reporting and enforcement after validating every legitimate sender.",
      tls: "Mail TLS needs separate certificate/client verification; no arbitrary DNS-target TCP probes are made.",
    },
    mailReady: false,
    mailActivation: domain.mail_activation,
  };
}
export async function lifecycle(
  actor: string,
  org: string,
  id: string,
  input: unknown,
) {
  z.uuid().parse(id);
  const { action } = z
    .object({ action: z.enum(["suspend", "resume", "retain", "reverify"]) })
    .strict()
    .parse(input);
  return tenantWrite(actor, org, "owner", async (db) => {
    const domain = await domains.get(org, id, db);
    if (!domain) throw new HttpError(404, "Domain not found");
    if (action === "reverify")
      await db.query(
        `UPDATE domains SET verification_status='pending',verified_at=NULL,verification_token=$3,
        verification_expires_at=NOW()+INTERVAL '7 days',mail_activation='disabled',
        revalidation_state='due',ownership_revalidated_at=NULL,revalidation_due_at=NOW(),
        revalidation_last_attempt_at=NULL,revalidation_failures=0,revalidation_grace_expires_at=NULL,
        revalidation_revision=revalidation_revision+1
        WHERE organization_id=$1 AND id=$2`,
        [org, id, randomBytes(32).toString("hex")],
      );
    else
      await db.query(
        "UPDATE domains SET status=$3,mail_activation=CASE WHEN $3='active' THEN mail_activation ELSE 'disabled' END,retained_at=CASE WHEN $3='retained' THEN NOW() ELSE NULL END WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          action === "resume"
            ? "active"
            : action === "retain"
              ? "retained"
              : "suspended",
        ],
      );
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "domain." + action,
      resourceId: id,
    });
    return {
      domain: await domains.get(org, id, db),
      mailPolicyChanged: false,
      mailDataDeleted: false,
    };
  });
}
