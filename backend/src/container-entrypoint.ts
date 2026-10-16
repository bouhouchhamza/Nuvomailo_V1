import { existsSync, readFileSync } from "node:fs";
import { loadSecretFiles, type ContainerRole } from "./config/secret-files.js";
let phase = "secret-loading";
try {
  const role = process.argv[2] ?? "api";
  if (
    !["api", "worker", "migrate"].includes(role) ||
    process.env.NODE_ENV !== "production" ||
    !existsSync("/.dockerenv")
  )
    throw new Error("Container entrypoint required");
  const loaded = loadSecretFiles(role as ContainerRole, process.env, (path) =>
    readFileSync(path, "utf8"),
  );
  for (const [name, value] of Object.entries(loaded))
    if (value !== undefined) process.env[name] = value;
  if (role === "worker") {
    await import("./workers/run-provisioning.js");
  } else if (role === "migrate") {
    phase = "migration-import";
    const { default: pool } = await import("./config/database.js"),
      { runner } = await import("node-pg-migrate");
    phase = "database-connect";
    const client = await pool.connect();
    try {
      phase = "schema-migration";
      await runner({
        dbClient: client,
        dir: "migrations",
        direction: "up",
        migrationsTable: "pgmigrations",
        log: () => {},
      });
      phase = "runtime-grants";
      await client.query(readFileSync("runtime-grants.sql", "utf8"));
      console.log('{"event":"migration_completed"}');
    } finally {
      client.release();
      await pool.end();
    }
  } else {
    const { createApp } = await import("./app.js"),
      { env } = await import("./config/env.js"),
      { default: pool } = await import("./config/database.js");
    if (!existsSync("/app/public/index.html"))
      throw new Error("Frontend build missing");
    const server = createApp({ staticAssets: "/app/public" }).listen(
      env.PORT,
      "0.0.0.0",
      () => console.log('{"event":"container_api_started"}'),
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        server.close(() => {
          void pool.end().then(() => process.exit(0));
        });
        setTimeout(() => process.exit(1), 10000).unref();
      });
  }
} catch (error) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code
      : "STARTUP_FAILED";
  console.error(
    JSON.stringify({ event: "container_startup_failed", phase, code }),
  );
  process.exitCode = 1;
}
