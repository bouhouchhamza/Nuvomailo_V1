import app from "./app.js";
import { env } from "./config/env.js";
import pool from "./config/database.js";
import { recordHeartbeat } from "./services/operations-alert.service.js";

const server = app.listen(env.PORT, "127.0.0.1", () => {
  console.log(`Nuvomailo API: http://127.0.0.1:${env.PORT}`);
});
const heartbeat = () =>
  recordHeartbeat("control-plane", `api:${process.pid}`).catch(() =>
    console.error("Control-plane heartbeat update failed"),
  );
void heartbeat();
const heartbeatTimer = setInterval(heartbeat, 30_000);
heartbeatTimer.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(heartbeatTimer);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
