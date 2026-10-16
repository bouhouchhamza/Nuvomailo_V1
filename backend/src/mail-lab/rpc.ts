import { request } from "node:http";
import { readFile } from "node:fs/promises";
export async function rpc(
  path: string,
  target: unknown,
  authenticated = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = (
    await readFile("/run/nuvomailo-worker-auth/token", "utf8")
  ).trim();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(target);
    const req = request(
      {
        socketPath: "/run/nuvomailo-agent/agent.sock",
        path,
        method: "POST",
        headers: {
          Authorization: authenticated ? `Bearer ${token}` : "Bearer invalid",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (data: Buffer) => chunks.push(data));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch {
            reject(new Error("INVALID_LAB_RESPONSE"));
          }
        });
      },
    );
    req.setTimeout(35000, () => req.destroy(new Error("LAB_RPC_TIMEOUT")));
    req.on("error", reject);
    req.end(body);
  });
}
