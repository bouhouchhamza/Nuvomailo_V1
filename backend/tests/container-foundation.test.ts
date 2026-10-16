import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import request from "supertest";
import { loadSecretFiles } from "../src/config/secret-files.js";
import { createApp } from "../src/app.js";
import pool from "../src/config/database.js";
after(async () => {
  await pool.end();
});
test("production API rejects a missing signing key while non-HTTP worker config needs no signing key", () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PGHOST: "127.0.0.1",
    PGPORT: "5432",
    PGUSER: "synthetic",
    PGDATABASE: "synthetic",
    PGPASSWORD: "synthetic-unused",
    DOTENV_CONFIG_PATH: join(tmpdir(), `nuvomailo-missing-${randomUUID()}.env`),
  };
  delete env.JWT_SECRET;
  delete env.IDENTITY_ENCRYPTION_KEY;
  const run = (code: string) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { encoding: "utf8", env },
    );
  assert.match(
    run(
      "try { await import('./src/middlewares/auth.ts'); process.exit(2); } catch { console.log('production-auth-rejected'); }",
    ),
    /production-auth-rejected/,
  );
  assert.match(
    run(
      "await import('./src/config/env.ts'); console.log('worker-config-without-signing-key');",
    ),
    /worker-config-without-signing-key/,
  );
});
test("container secret paths are role-bound and worker cannot receive signing/identity keys", () => {
  const env = loadSecretFiles(
    "worker",
    { PGPASSWORD_FILE: "/run/secrets/db-worker-password" },
    (path) => {
      assert.equal(path, "/run/secrets/db-worker-password");
      return "synthetic-db-only\n";
    },
  );
  assert.equal(env.PGPASSWORD, "synthetic-db-only");
  assert.equal(env.JWT_SECRET, undefined);
  assert.throws(() =>
    loadSecretFiles(
      "worker",
      { JWT_SECRET: "synthetic-signing-key" },
      () => "",
    ),
  );
  assert.throws(() =>
    loadSecretFiles("api", { PGPASSWORD_FILE: "/etc/passwd" }, () => ""),
  );
  assert.throws(() =>
    loadSecretFiles(
      "api",
      {
        PGPASSWORD_FILE: "/run/secrets/db-api-password",
        PGPASSWORD: "ambiguous",
      },
      () => "",
    ),
  );
});
test("trusted static frontend supports SPA navigation while API/hidden files remain isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuvomailo-static-"));
  try {
    await writeFile(join(root, "index.html"), "<h1>Synthetic dashboard</h1>");
    await writeFile(join(root, ".env"), "synthetic-private-marker");
    const app = createApp({ staticAssets: root });
    const page = await request(app)
      .get("/organizations/example")
      .set("Accept", "text/html");
    assert.equal(page.status, 200);
    assert.match(page.text, /Synthetic dashboard/);
    assert.equal(page.headers["cache-control"], "no-cache");
    const hidden = await request(app).get("/.env");
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(hidden.text, /synthetic-private-marker/);
    const api = await request(app)
      .get("/api/unknown")
      .set("Accept", "text/html");
    assert.equal(api.status, 404);
    assert.equal(api.headers["cache-control"], "no-store");
    assert.doesNotMatch(api.text, /Synthetic dashboard/);
  } finally {
    await unlink(join(root, "index.html"));
    await unlink(join(root, ".env"));
    await rmdir(root);
  }
});
