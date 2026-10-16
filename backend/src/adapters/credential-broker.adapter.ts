import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
export interface CredentialBroker {
  readonly mode: "local-lab";
  hash(password: string): Promise<string>;
}
export class LocalCredentialBroker implements CredentialBroker {
  readonly mode = "local-lab" as const;
  constructor() {
    if (env.NODE_ENV === "production")
      throw new Error("Synthetic broker is local only");
  }
  async hash(password: string) {
    const token = (
      await readFile("/run/nuvomailo-broker-auth/token", "utf8")
    ).trim();
    return new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({ password });
      const req = request(
        {
          socketPath: "/run/nuvomailo-credential-broker/broker.sock",
          path: "/v1/hash",
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(body),
            "Content-Type": "application/json",
          },
        },
        (res) => {
          let output = "";
          res.on("data", (chunk) => {
            output += chunk;
            if (output.length > 2048)
              req.destroy(new Error("BROKER_RESPONSE_LIMIT"));
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(output);
              if (
                res.statusCode !== 200 ||
                typeof parsed.hash !== "string" ||
                !parsed.hash.startsWith("{ARGON2ID}$argon2id$")
              )
                throw new Error();
              resolve(parsed.hash);
            } catch {
              reject(new Error("BROKER_UNAVAILABLE"));
            }
          });
        },
      );
      req.setTimeout(25000, () => req.destroy(new Error("BROKER_TIMEOUT")));
      req.on("error", () => reject(new Error("BROKER_UNAVAILABLE")));
      req.end(body);
    });
  }
}
