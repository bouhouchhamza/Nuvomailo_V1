import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  ProvisioningError,
  type MailProvisioningAdapter,
  type MailboxObservation,
  type MailboxTarget,
  type EnsureResult,
} from "../services/provisioning.adapter.js";
const targetSchema = z
  .object({
    organizationId: z.uuid(),
    mailboxId: z.uuid(),
    address: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*@tenant-[ab]\.lab\.invalid$/),
    revision: z.number().int().positive(),
    quotaMb: z.union([z.literal(100), z.literal(200)]),
    status: z.enum(["active", "suspended"]),
    inboundPolicy: z.enum(["accept", "defer"]),
    idempotencyKey: z.uuid(),
  })
  .strict();
const observedSchema = z
  .object({
    status: z.enum(["unknown", "absent", "active", "suspended"]),
    quotaMb: z.number().int().positive().nullable(),
    inboundPolicy: z.enum(["unknown", "accept", "defer"]),
  })
  .strict();
/** Explicit lab-only construction; never selected by the public API/default worker. */
export class DmsLabAdapter implements MailProvisioningAdapter {
  readonly mode = "local-lab" as const;
  private readonly socket = "/run/nuvomailo-agent/agent.sock";
  private readonly tokenPath = "/run/nuvomailo-worker-auth/token";
  private async call(
    path: "/v1/inspect" | "/v1/ensure",
    target: MailboxTarget,
    signal: AbortSignal,
  ): Promise<unknown> {
    targetSchema.parse(target);
    const token = (await readFile(this.tokenPath, "utf8")).trim();
    const body = JSON.stringify(target);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          path,
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4096) {
              req.destroy();
              reject(new ProvisioningError("PROVIDER_REJECTED", false));
            } else chunks.push(chunk);
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(
                new ProvisioningError(
                  res.statusCode === 503
                    ? "PROVIDER_UNAVAILABLE"
                    : "PROVIDER_REJECTED",
                  res.statusCode === 503,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new ProvisioningError("PROVIDER_REJECTED", false));
            }
          });
          res.on("error", () =>
            reject(new ProvisioningError("PROVIDER_UNAVAILABLE", true)),
          );
        },
      );
      req.setTimeout(30000, () => req.destroy());
      req.on("error", () =>
        reject(
          new ProvisioningError(
            signal.aborted ? "OPERATION_TIMEOUT" : "PROVIDER_UNAVAILABLE",
            true,
          ),
        ),
      );
      req.end(body);
    });
  }
  async inspect(
    target: MailboxTarget,
    signal: AbortSignal,
  ): Promise<MailboxObservation> {
    return observedSchema.parse(await this.call("/v1/inspect", target, signal));
  }
  async ensure(
    target: MailboxTarget,
    signal: AbortSignal,
  ): Promise<EnsureResult> {
    return z
      .object({ status: z.literal("applied") })
      .strict()
      .parse(await this.call("/v1/ensure", target, signal));
  }
}
