import { Router } from "express";
import { register, login, me } from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/auth.js";
import { rateLimit } from "express-rate-limit";
import { cookieName, sessionResponse } from "../controllers/auth.controller.js";
import { currentUser } from "../services/auth.service.js";
import { loginUser } from "../services/auth.service.js";
import * as mfa from "../services/mfa.service.js";
import * as sessions from "../services/session.service.js";
import { env } from "../config/env.js";
import { HttpError } from "../middlewares/errors.js";
import { z } from "zod";

export function authRouter(
  notification?: sessions.IdentityNotification,
  mfaKey?: Buffer,
) {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      req.headers.origin !== env.FRONTEND_ORIGIN
    )
      throw new HttpError(403, "Origin not allowed");
    next();
  });

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many authentication attempts. Try again later." },
  });
  router.post("/register", limiter, register);
  router.post("/login", limiter, async (req, res) => {
    sessionResponse(res, await loginUser(req.body, mfaKey));
  });
  router.get("/me", authenticate, me);
  router.get("/mfa", authenticate, async (req, res) => {
    res.json(await mfa.state(req.userId));
  });
  router.post("/mfa/enroll", limiter, authenticate, async (req, res) => {
    res.json(await mfa.enroll(req.userId, req.body, mfaKey));
  });
  router.post("/mfa/confirm", limiter, authenticate, async (req, res) => {
    res.json(await mfa.confirm(req.userId, req.body, mfaKey));
  });
  router.post("/mfa/disable", limiter, authenticate, async (req, res) => {
    await mfa.disable(req.userId, req.body, mfaKey);
    res.sendStatus(204);
  });
  router.post("/mfa/step-up", limiter, authenticate, async (req, res) => {
    await mfa.stepUp(req.userId, req.sessionId, req.body, mfaKey);
    res.sendStatus(204);
  });
  const csrf: import("express").RequestHandler = (req, _res, next) => {
    if (
      req.headers["x-nuvomailo-csrf"] !== "1" ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw new HttpError(403, "CSRF protection required");
    next();
  };
  router.post("/refresh", limiter, csrf, async (req, res) => {
    const raw = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    sessionResponse(res, await sessions.refreshSession(raw));
  });
  router.post("/logout", csrf, authenticate, async (req, res) => {
    await sessions.revokeSession(req.userId, req.sessionId);
    res.clearCookie(cookieName, { path: "/api/auth" });
    res.sendStatus(204);
  });
  router.get("/sessions", authenticate, async (req, res) => {
    res.json(await sessions.sessions(req.userId));
  });
  router.delete("/sessions/:id", authenticate, async (req, res) => {
    await sessions.revokeSession(req.userId, z.uuid().parse(req.params.id));
    res.sendStatus(204);
  });
  router.get("/security-events", authenticate, async (req, res) => {
    res.json(await sessions.events(req.userId));
  });
  router.post("/revoke-all", authenticate, async (req, res) => {
    await sessions.revokeSession(req.userId);
    res.clearCookie(cookieName, { path: "/api/auth" });
    res.sendStatus(204);
  });
  router.post("/change-password", limiter, authenticate, async (req, res) => {
    await sessions.changePassword(req.userId, req.body);
    res.clearCookie(cookieName, { path: "/api/auth" });
    res.sendStatus(204);
  });
  router.post("/forgot-password", limiter, async (req, res) => {
    const { email } = z
      .object({ email: z.string().trim().toLowerCase().email() })
      .strict()
      .parse(req.body);
    await sessions.requestGrant(email, "reset", notification);
    res
      .status(202)
      .json({
        message: "If eligible, recovery instructions will be delivered.",
        deliveryAvailable: !!notification,
      });
  });
  router.post("/reset-password", limiter, async (req, res) => {
    await sessions.consumeGrant(req.body, "reset");
    res.sendStatus(204);
  });
  router.post("/verification", limiter, authenticate, async (req, res) => {
    if (!notification)
      throw new HttpError(503, "Notification delivery is not configured");
    const user = await currentUser(req.userId);
    await sessions.requestGrant(user.email, "verify", notification);
    res.sendStatus(202);
  });
  router.post("/verify-email", limiter, async (req, res) => {
    await sessions.consumeGrant(req.body, "verify");
    res.sendStatus(204);
  });
  return router;
}

export default authRouter();
