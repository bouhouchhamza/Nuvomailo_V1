import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticate } from "../middlewares/auth.js";
import { MailboxCredentialService } from "../services/mailbox-credential.service.js";
import { HttpError } from "../middlewares/errors.js";
import { env } from "../config/env.js";
export function mailboxCredentialRouter(service: MailboxCredentialService) {
  const router = Router();
  router.use(
    authenticate,
    rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
  );
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.method !== "GET" &&
      (req.headers["x-nuvomailo-csrf"] !== "1" ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== env.FRONTEND_ORIGIN))
    )
      throw new HttpError(403, "CSRF protection required");
    next();
  });
  router.get("/", (_req, res) => {
    res.json(service.capabilities());
  });
  router.get("/requests/:id", async (req, res) => {
    res.json(
      await service.status(req.userId, req.sessionId, String(req.params.id)),
    );
  });
  router.post("/:mailboxId/grants", async (req, res) => {
    res
      .status(202)
      .json(
        await service.issue(
          req.userId,
          req.sessionId,
          String(req.params.mailboxId),
          req.body,
        ),
      );
  });
  router.post("/consume", async (req, res) => {
    res
      .status(202)
      .json(await service.consume(req.userId, req.sessionId, req.body));
  });
  return router;
}
