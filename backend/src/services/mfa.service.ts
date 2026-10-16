import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import * as OTPAuth from "otpauth";
import argon2 from "argon2";
import { z } from "zod";
import type { Db } from "../repositories/transaction.js";
import { transaction } from "../repositories/transaction.js";
import pool from "../config/database.js";
import { HttpError } from "../middlewares/errors.js";
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function keyRequired(key?: Buffer): Buffer {
  if (!key || key.length !== 32)
    throw new HttpError(503, "MFA encryption service is not configured");
  return key;
}
function seal(value: string, userId: string, key?: Buffer) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", keyRequired(key), nonce);
  cipher.setAAD(Buffer.from("nuvomailo:mfa:" + userId));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}
function open(value: string, userId: string, key?: Buffer) {
  const [version, nonce, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext)
    throw new HttpError(503, "MFA unavailable");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyRequired(key),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from("nuvomailo:mfa:" + userId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
function totp(secret: string, email = "account") {
  return new OTPAuth.TOTP({
    issuer: "Nuvomailo",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
export async function verifyFactor(
  db: Db,
  user: {
    id: string;
    mfa_secret_enc?: string | null;
    mfa_last_counter: string | number;
  },
  factor?: string,
  key?: Buffer,
) {
  if (!user.mfa_secret_enc) return false;
  if (!factor) throw new HttpError(401, "Authentication failed");
  if (/^\d{6}$/.test(factor)) {
    const otp = totp(open(user.mfa_secret_enc, user.id, key));
    const timestamp = Date.now();
    const delta = otp.validate({ token: factor, window: 1, timestamp });
    const counter = otp.counter({ timestamp }) + (delta ?? 0);
    if (delta === null || counter <= Number(user.mfa_last_counter))
      throw new HttpError(401, "Authentication failed");
    await db.query("UPDATE users SET mfa_last_counter=$2 WHERE id=$1", [
      user.id,
      counter,
    ]);
  } else {
    const consumed = await db.query(
      "UPDATE mfa_recovery_codes SET used_at=NOW() WHERE user_id=$1 AND digest=$2 AND used_at IS NULL RETURNING digest",
      [user.id, fingerprint(factor)],
    );
    if (!consumed.rowCount) throw new HttpError(401, "Authentication failed");
  }
  return true;
}
async function passwordUser(db: Db, id: string, password: string) {
  const user = (
    await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (
    !user ||
    user.status !== "active" ||
    !(await argon2.verify(user.password_hash, password))
  )
    throw new HttpError(401, "Authentication failed");
  return user;
}
async function event(db: Db, id: string, action: string) {
  await db.query("INSERT INTO security_events(user_id,action) VALUES($1,$2)", [
    id,
    action,
  ]);
}
export async function state(id: string) {
  const user = (
    await pool.query(
      "SELECT mfa_secret_enc IS NOT NULL AS enabled FROM users WHERE id=$1",
      [id],
    )
  ).rows[0];
  return { enabled: !!user?.enabled };
}
export async function enroll(id: string, input: unknown, key?: Buffer) {
  const { password } = z
    .object({ password: z.string().min(1).max(128) })
    .strict()
    .parse(input);
  keyRequired(key);
  return transaction(async (db) => {
    const user = await passwordUser(db, id, password);
    if (user.mfa_secret_enc) throw new HttpError(409, "MFA already enabled");
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await db.query(
      "UPDATE users SET mfa_pending_enc=$2,mfa_pending_expires=NOW()+INTERVAL '5 minutes' WHERE id=$1",
      [id, seal(secret, id, key)],
    );
    await event(db, id, "identity.mfa_enrollment_started");
    return { uri: totp(secret, user.email).toString(), expiresIn: 300 };
  });
}
export async function confirm(id: string, input: unknown, key?: Buffer) {
  const { factor } = z
    .object({ factor: z.string().regex(/^\d{6}$/) })
    .strict()
    .parse(input);
  return transaction(async (db) => {
    const user = (
      await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (
      !user ||
      user.mfa_secret_enc ||
      !user.mfa_pending_enc ||
      new Date(user.mfa_pending_expires).getTime() <= Date.now()
    )
      throw new HttpError(409, "Enrollment unavailable");
    await verifyFactor(
      db,
      { ...user, mfa_secret_enc: user.mfa_pending_enc },
      factor,
      key,
    );
    await db.query(
      "UPDATE users SET mfa_secret_enc=mfa_pending_enc,mfa_pending_enc=NULL,mfa_pending_expires=NULL,auth_version=auth_version+1 WHERE id=$1",
      [id],
    );
    await db.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [id]);
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomBytes(16).toString("hex"),
    );
    for (const code of recoveryCodes)
      await db.query(
        "INSERT INTO mfa_recovery_codes(digest,user_id) VALUES($1,$2)",
        [fingerprint(code), id],
      );
    await db.query(
      "UPDATE identity_sessions SET revoked_at=NOW() WHERE user_id=$1",
      [id],
    );
    await event(db, id, "identity.mfa_enabled");
    return { recoveryCodes };
  });
}
export async function disable(id: string, input: unknown, key?: Buffer) {
  const data = z
    .object({
      password: z.string().min(1).max(128),
      factor: z.string().min(6).max(128),
    })
    .strict()
    .parse(input);
  return transaction(async (db) => {
    const user = await passwordUser(db, id, data.password);
    if (
      (await db.query("SELECT 1 FROM platform_staff WHERE user_id=$1", [id]))
        .rowCount
    )
      throw new HttpError(409, "Staff accounts must retain MFA");
    if (!(await verifyFactor(db, user, data.factor, key)))
      throw new HttpError(409, "MFA not enabled");
    await db.query(
      "UPDATE users SET mfa_secret_enc=NULL,mfa_last_counter=-1,auth_version=auth_version+1 WHERE id=$1",
      [id],
    );
    await db.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [id]);
    await db.query(
      "UPDATE identity_sessions SET revoked_at=NOW() WHERE user_id=$1",
      [id],
    );
    await event(db, id, "identity.mfa_disabled");
  });
}
export async function stepUp(
  id: string,
  sessionId: string | undefined,
  input: unknown,
  key?: Buffer,
) {
  const { factor } = z
    .object({ factor: z.string().min(6).max(128) })
    .strict()
    .parse(input);
  if (!sessionId) throw new HttpError(401, "A persistent session is required");
  await transaction(async (db) => {
    const user = (
      await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (
      !user ||
      user.status !== "active" ||
      !(await verifyFactor(db, user, factor, key))
    )
      throw new HttpError(401, "Authentication failed");
    const changed = await db.query(
      "UPDATE identity_sessions SET mfa_verified_at=NOW() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>NOW() RETURNING id",
      [sessionId, id],
    );
    if (!changed.rowCount) throw new HttpError(401, "Invalid session");
    await event(db, id, "identity.mfa_step_up");
  });
}
