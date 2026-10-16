import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import argon2 from "argon2";
import pool from "../config/database.js";
import { transaction, type Db } from "../repositories/transaction.js";
import { issueToken } from "../middlewares/auth.js";
import { HttpError } from "../middlewares/errors.js";
import { verifyFactor } from "./mfa.service.js";
export const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const fresh = () => randomBytes(48).toString("base64url");
const passwordSchema = z.string().min(12).max(128);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{64}$/);
export const hashPassword = (value: string) =>
  argon2.hash(value, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export async function securityEvent(db: Db, userId: string, action: string) {
  await db.query("INSERT INTO security_events(user_id,action) VALUES($1,$2)", [
    userId,
    action,
  ]);
}
async function lockedUser(db: Db, id: string) {
  return (await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id]))
    .rows[0];
}
function response(
  user: { id: string; email: string; created_at: Date; auth_version: number },
  sessionId: string,
) {
  return {
    user: { id: user.id, email: user.email, created_at: user.created_at },
    accessToken: issueToken(user.id, sessionId, user.auth_version),
    expiresIn: 900,
  };
}
export async function createSession(
  userId: string,
  expectedHash: string,
  factor?: string,
  mfaKey?: Buffer,
) {
  return transaction(async (db) => {
    const user = await lockedUser(db, userId);
    if (
      !user ||
      user.status !== "active" ||
      user.password_hash !== expectedHash
    )
      throw new HttpError(401, "Invalid email or password");
    const verified = await verifyFactor(db, user, factor, mfaKey);
    const session = (
      await db.query(
        "INSERT INTO identity_sessions(user_id,expires_at) VALUES($1,NOW()+INTERVAL '30 days') RETURNING id",
        [userId],
      )
    ).rows[0]!;
    const refreshToken = fresh();
    if (verified)
      await db.query(
        "UPDATE identity_sessions SET mfa_verified_at=NOW() WHERE id=$1",
        [session.id],
      );
    await db.query(
      "INSERT INTO refresh_tokens(digest,session_id) VALUES($1,$2)",
      [digest(refreshToken), session.id],
    );
    await securityEvent(db, userId, "identity.login");
    return { ...response(user, session.id), refreshToken };
  });
}
export async function refreshSession(raw: unknown) {
  const parsed = tokenSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(401, "Invalid or expired session");
  const fingerprint = digest(parsed.data);
  const result = await transaction(async (db) => {
    const lookup = (
      await db.query(
        "SELECT s.user_id FROM refresh_tokens r JOIN identity_sessions s ON s.id=r.session_id WHERE r.digest=$1",
        [fingerprint],
      )
    ).rows[0];
    if (!lookup) return null;
    const user = await lockedUser(db, lookup.user_id);
    const row = (
      await db.query(
        "SELECT s.*,r.consumed_at FROM refresh_tokens r JOIN identity_sessions s ON s.id=r.session_id WHERE r.digest=$1 FOR UPDATE OF s,r",
        [fingerprint],
      )
    ).rows[0];
    if (
      !user ||
      !row ||
      user.status !== "active" ||
      row.revoked_at ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      return null;
    if (row.consumed_at) {
      await db.query(
        "UPDATE identity_sessions SET revoked_at=NOW() WHERE id=$1",
        [row.id],
      );
      await securityEvent(db, user.id, "identity.refresh_replay");
      return null;
    }
    await db.query(
      "UPDATE refresh_tokens SET consumed_at=NOW() WHERE digest=$1",
      [fingerprint],
    );
    const refreshToken = fresh();
    await db.query(
      "INSERT INTO refresh_tokens(digest,session_id) VALUES($1,$2)",
      [digest(refreshToken), row.id],
    );
    await db.query(
      "UPDATE identity_sessions SET last_used_at=NOW() WHERE id=$1",
      [row.id],
    );
    return { ...response(user, row.id), refreshToken };
  });
  if (!result) throw new HttpError(401, "Invalid or expired session");
  return result;
}
export async function revokeSession(userId: string, sessionId?: string) {
  await transaction(async (db) => {
    await lockedUser(db, userId);
    await db.query(
      "UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2)",
      [userId, sessionId ?? null],
    );
    if (!sessionId)
      await db.query(
        "UPDATE users SET auth_version=auth_version+1 WHERE id=$1",
        [userId],
      );
    await securityEvent(
      db,
      userId,
      sessionId ? "identity.logout" : "identity.revoke_all",
    );
  });
}
export async function sessions(userId: string) {
  return (
    await pool.query(
      "SELECT id,created_at,expires_at,last_used_at,revoked_at FROM identity_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
      [userId],
    )
  ).rows;
}
export async function events(userId: string) {
  return (
    await pool.query(
      "SELECT id,action,created_at FROM security_events WHERE user_id=$1 ORDER BY id DESC LIMIT 100",
      [userId],
    )
  ).rows;
}
export async function changePassword(userId: string, input: unknown) {
  const data = z
    .object({
      currentPassword: z.string().min(1).max(128),
      password: passwordSchema,
    })
    .strict()
    .parse(input);
  const hashed = await hashPassword(data.password);
  await transaction(async (db) => {
    const user = await lockedUser(db, userId);
    if (
      !user ||
      user.status !== "active" ||
      !(await argon2.verify(user.password_hash, data.currentPassword))
    )
      throw new HttpError(401, "Authentication failed");
    await db.query(
      "UPDATE users SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1",
      [userId, hashed],
    );
    await db.query(
      "UPDATE identity_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL",
      [userId],
    );
    await db.query(
      "UPDATE identity_grants SET revoked_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
      [userId],
    );
    await securityEvent(db, userId, "identity.password_changed");
  });
}
/** Explicit injected delivery only; default runtime has no mail or token-disclosing sink. */
export interface IdentityNotification {
  send(value: {
    email: string;
    purpose: "reset" | "verify";
    token: string;
  }): Promise<void>;
}
export async function requestGrant(
  email: string,
  purpose: "reset" | "verify",
  sink?: IdentityNotification,
) {
  if (!sink) return;
  const grant = await transaction(async (db) => {
    const user = (
      await db.query("SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE", [
        email,
      ])
    ).rows[0];
    if (!user || user.status !== "active") return null;
    await db.query(
      "UPDATE identity_grants SET revoked_at=NOW() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
      [user.id, purpose],
    );
    const token = fresh();
    await db.query(
      "INSERT INTO identity_grants(digest,user_id,purpose,auth_version,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '15 minutes')",
      [digest(token), user.id, purpose, user.auth_version],
    );
    await securityEvent(db, user.id, "identity." + purpose + "_requested");
    return { email: user.email as string, purpose, token };
  });
  if (grant) {
    try {
      await sink.send(grant);
    } catch {
      await pool.query(
        "UPDATE identity_grants SET revoked_at=NOW() WHERE digest=$1",
        [digest(grant.token)],
      );
    }
  }
}
export async function consumeGrant(
  input: unknown,
  purpose: "reset" | "verify",
) {
  const data = z
    .object({
      token: tokenSchema,
      password: purpose === "reset" ? passwordSchema : z.undefined().optional(),
    })
    .strict()
    .parse(input);
  const hashed =
    purpose === "reset" ? await hashPassword(data.password!) : null;
  const accepted = await transaction(async (db) => {
    const found = (
      await db.query("SELECT user_id FROM identity_grants WHERE digest=$1", [
        digest(data.token),
      ])
    ).rows[0];
    if (!found) return false;
    const user = await lockedUser(db, found.user_id);
    const grant = (
      await db.query(
        "SELECT * FROM identity_grants WHERE digest=$1 FOR UPDATE",
        [digest(data.token)],
      )
    ).rows[0];
    if (
      !user ||
      user.status !== "active" ||
      !grant ||
      grant.purpose !== purpose ||
      grant.consumed_at ||
      grant.revoked_at ||
      grant.auth_version !== user.auth_version ||
      new Date(grant.expires_at).getTime() <= Date.now()
    )
      return false;
    await db.query(
      "UPDATE identity_grants SET consumed_at=NOW() WHERE digest=$1",
      [digest(data.token)],
    );
    if (purpose === "verify")
      await db.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [
        user.id,
      ]);
    else {
      await db.query(
        "UPDATE users SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1",
        [user.id, hashed],
      );
      await db.query(
        "UPDATE identity_sessions SET revoked_at=NOW() WHERE user_id=$1",
        [user.id],
      );
      await db.query(
        "UPDATE identity_grants SET revoked_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
        [user.id],
      );
    }
    await securityEvent(db, user.id, "identity." + purpose + "_completed");
    return true;
  });
  if (!accepted) throw new HttpError(400, "Invalid or expired grant");
}
