import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  UsageProviderError,
  type MailboxUsageReader,
  type MailboxUsageTarget,
} from "../services/mailbox-usage.adapter.js";
const targetSchema = z
  .object({
    organizationId: z.uuid(),
    mailboxId: z.uuid(),
    address: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*@tenant-[ab]\.lab\.invalid$/),
  })
  .strict();
const resultSchema = z
  .object({
    usageBytes: z.number().int().nonnegative().safe(),
    messageCount: z.number().int().nonnegative().safe(),
  })
  .strict();
export class DmsUsageLabAdapter implements MailboxUsageReader {
  readonly mode = "local-lab" as const;
  async read(target: MailboxUsageTarget, signal: AbortSignal) {
    targetSchema.parse(target);
    const token = (
        await readFile("/run/nuvomailo-worker-auth/token", "utf8")
      ).trim(),
      body = JSON.stringify(target);
    return new Promise<ReturnType<typeof resultSchema.parse>>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: "/run/nuvomailo-agent/agent.sock",
            path: "/v1/usage",
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
                reject(new UsageProviderError("PROVIDER_REJECTED", false));
              } else chunks.push(chunk);
            });
            res.on("end", () => {
              if (res.statusCode !== 200) {
                reject(
                  new UsageProviderError(
                    res.statusCode === 503
                      ? "PROVIDER_UNAVAILABLE"
                      : "PROVIDER_REJECTED",
                    res.statusCode === 503,
                  ),
                );
                return;
              }
              try {
                resolve(
                  resultSchema.parse(
                    JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  ),
                );
              } catch {
                reject(new UsageProviderError("PROVIDER_REJECTED", false));
              }
            });
          },
        );
        req.setTimeout(15000, () => req.destroy());
        req.on("error", () =>
          reject(
            new UsageProviderError(
              signal.aborted ? "OPERATION_TIMEOUT" : "PROVIDER_UNAVAILABLE",
              true,
            ),
          ),
        );
        req.end(body);
      },
    );
  }
}
