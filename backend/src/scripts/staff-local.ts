import { z } from "zod";
import pool from "../config/database.js";
import { env } from "../config/env.js";
import { transaction } from "../repositories/transaction.js";
try {
  if (env.NODE_ENV === "production") throw new Error("LOCAL_SYNTHETIC_ONLY");
  const [id, role] = process.argv.slice(2);
  z.uuid().parse(id);
  z.enum(["viewer", "operator", "revoke"]).parse(role);
  const user = (
    await pool.query(
      "SELECT email,status,email_verified_at,mfa_secret_enc FROM users WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (
    !user ||
    !/@(?:[a-z0-9.-]+\.)?(?:example\.test|lab\.invalid)$/.test(user.email)
  )
    throw new Error("SYNTHETIC_IDENTITY_REQUIRED");
  if (
    role !== "revoke" &&
    (user.status !== "active" ||
      !user.email_verified_at ||
      !user.mfa_secret_enc)
  )
    throw new Error("VERIFIED_MFA_IDENTITY_REQUIRED");
  if (process.argv.includes("--apply"))
    await transaction(async (db) => {
      if (role === "revoke")
        await db.query("DELETE FROM platform_staff WHERE user_id=$1", [id]);
      else
        await db.query(
          "INSERT INTO platform_staff(user_id,role) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role",
          [id, role],
        );
      await db.query(
        "INSERT INTO platform_events(action,target_id,reason) VALUES($1,$2,'local-synthetic-bootstrap')",
        [role === "revoke" ? "staff.revoked" : "staff.granted", id],
      );
    });
  console.log(
    JSON.stringify({
      mode: "local-synthetic",
      applied: process.argv.includes("--apply"),
      role,
    }),
  );
} catch {
  console.error(JSON.stringify({ error: "STAFF_LOCAL_OPERATION_REJECTED" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
