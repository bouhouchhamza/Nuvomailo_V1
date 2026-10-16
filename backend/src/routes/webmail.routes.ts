import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticate } from "../middlewares/auth.js";
import { WebmailService } from "../services/webmail.service.js";
import type { WebmailProvider } from "../adapters/webmail.adapter.js";
import { env } from "../config/env.js";
import { HttpError } from "../middlewares/errors.js";
const cookie = "nuvomailo_mail";
export function webmailRouter(provider?: WebmailProvider) {
  const router = Router(),
    service = new WebmailService(provider);
  router.use(authenticate);
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use((req, _res, next) => {
    if (
      req.method !== "GET" &&
      (req.headers["x-nuvomailo-csrf"] !== "1" ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== env.FRONTEND_ORIGIN))
    )
      throw new HttpError(403, "CSRF protection required");
    next();
  });
  const token = (req: import("express").Request) =>
    req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookie + "="))
      ?.slice(cookie.length + 1);
  router.get("/", async (req, res) => {
    res.json(await service.available(req.userId));
  });
  router.post("/connect", async (req, res) => {
    const { token: secret, ...result } = await service.connect(
      req.userId,
      req.sessionId,
      req.body,
    );
    res.cookie(cookie, secret, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/webmail",
      maxAge: 900000,
    });
    res.json(result);
  });
  router.post("/disconnect", (req, res) => {
    service.disconnect(req.userId, req.sessionId, token(req));
    res.clearCookie(cookie, { path: "/api/webmail" });
    res.sendStatus(204);
  });
  router.get("/folders", async (req, res) => {
    res.json(await service.folders(req.userId, req.sessionId, token(req)));
  });
  router.post("/folders", async (req, res) => {
    await service.createFolder(req.userId, req.sessionId, token(req), req.body);
    res.sendStatus(201);
  });
  router.get("/messages", async (req, res) => {
    res.json(
      await service.list(req.userId, req.sessionId, token(req), req.query),
    );
  });
  router.get("/message", async (req, res) => {
    res.json(
      await service.message(req.userId, req.sessionId, token(req), req.query),
    );
  });
  router.get("/attachment", async (req, res) => {
    const item = await service.attachment(
      req.userId,
      req.sessionId,
      token(req),
      req.query,
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${item.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "attachment"}"`,
    );
    res.send(item.content);
  });
  router.post("/message", async (req, res) => {
    await service.change(req.userId, req.sessionId, token(req), req.body);
    res.sendStatus(204);
  });
  router.get("/contacts", async (req, res) => {
    res.json(await service.contacts(req.userId, req.sessionId, token(req)));
  });
  router.post("/contacts", async (req, res) => {
    res
      .status(201)
      .json(
        await service.saveContact(
          req.userId,
          req.sessionId,
          token(req),
          req.body,
        ),
      );
  });
  router.delete("/contacts/:id", async (req, res) => {
    await service.deleteContact(
      req.userId,
      req.sessionId,
      token(req),
      req.params.id!,
    );
    res.sendStatus(204);
  });
  router.get("/send-attempts", async (req, res) => {
    res.json(await service.sendAttempts(req.userId, req.sessionId, token(req)));
  });
  router.post("/send-attempts/:id/resolve", async (req, res) => {
    res.json(
      await service.resolveSendAttempt(
        req.userId,
        req.sessionId,
        token(req),
        req.params.id!,
        req.body,
      ),
    );
  });
  router.post("/send", async (req, res) => {
    res.json(
      await service.compose(req.userId, req.sessionId, token(req), req.body),
    );
  });
  router.post("/draft", async (req, res) => {
    res.json(
      await service.compose(
        req.userId,
        req.sessionId,
        token(req),
        req.body,
        true,
      ),
    );
  });
  return router;
}
