import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "./errors.js";
import pool from "../config/database.js";

if (env.NODE_ENV === "production" && !env.JWT_SECRET)
  throw new Error("JWT_SECRET is required for production HTTP authentication");
const secret = env.JWT_SECRET ?? randomBytes(48).toString("hex");
if (!env.JWT_SECRET && env.NODE_ENV !== "test")
  console.warn(
    "Using ephemeral development JWT secret; sessions expire on restart.",
  );
declare global {
  namespace Express {
    interface Request {
      userId: string;
      sessionId?: string;
    }
  }
}
export function issueToken(userId: string, sessionId?: string, version = 0) {
  return jwt.sign(
    { v: version, ...(sessionId ? { sid: sessionId } : {}) },
    secret,
    {
      subject: userId,
      expiresIn: "15m",
      issuer: "nuvomailo",
      audience: "nuvomailo-dashboard",
      algorithm: "HS256",
    },
  );
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new HttpError(401, "Authentication required");
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "nuvomailo",
      audience: "nuvomailo-dashboard",
    });
    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        payload.sub,
      )
    )
      throw new Error();
    req.userId = payload.sub;
    if (
      payload.sid !== undefined &&
      (typeof payload.sid !== "string" || !/^[a-f0-9-]{36}$/i.test(payload.sid))
    )
      throw new Error();
    if (env.NODE_ENV === "production" && !payload.sid) throw new Error();
    const user = (
      await pool.query("SELECT status,auth_version FROM users WHERE id=$1", [
        payload.sub,
      ])
    ).rows[0];
    if (!user || user.status !== "active" || user.auth_version !== payload.v)
      throw new Error();
    if (payload.sid) {
      const session = (
        await pool.query(
          "SELECT id FROM identity_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>NOW()",
          [payload.sid, payload.sub],
        )
      ).rows[0];
      if (!session) throw new Error();
      req.sessionId = payload.sid;
    }
  } catch {
    throw new HttpError(401, "Invalid or expired access token");
  }
  next();
};
