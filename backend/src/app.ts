import express from "express";
import { authRouter } from "./routes/auth.routes.js";
import type { IdentityNotification } from "./services/session.service.js";
import { tenantRouter } from "./routes/tenant.routes.js";
import type { TxtResolver } from "./services/domain.service.js";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/errors.js";
import { requestContext } from "./middlewares/request-context.js";
import pool from "./config/database.js";
import { authenticate } from "./middlewares/auth.js";
import * as invitations from "./services/invitation.service.js";
import { platformRouter } from "./routes/platform.routes.js";
import { billingRouter } from "./routes/billing.routes.js";
import * as billing from "./services/billing.service.js";
import { webmailRouter } from "./routes/webmail.routes.js";
import type { WebmailProvider } from "./adapters/webmail.adapter.js";
import { MailboxCredentialService } from "./services/mailbox-credential.service.js";
import { mailboxCredentialRouter } from "./routes/mailbox-credential.routes.js";
export function createApp(
  options: {
    resolveTxt?: TxtResolver;
    identityNotification?: IdentityNotification;
    identityEncryptionKey?: Buffer;
    paymentProvider?: billing.PaymentProvider;
    webmailProvider?: WebmailProvider;
    mailboxCredentialService?: MailboxCredentialService;
    staticAssets?: string;
  } = {},
) {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(helmet());
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
  app.post(
    "/api/billing-webhooks/sandbox",
    express.raw({ type: "application/json", limit: "16kb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "Expected raw JSON" });
        return;
      }
      res.json(
        await billing.webhook(
          req.body,
          (req.headers["x-sandbox-signature"] as string) ?? "",
          options.paymentProvider,
        ),
      );
    },
  );
  app.use(
    "/api/webmail",
    express.json({ limit: "8mb" }),
    webmailRouter(options.webmailProvider),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use(
    "/api/mailbox-credentials",
    mailboxCredentialRouter(
      options.mailboxCredentialService ?? new MailboxCredentialService(),
    ),
  );

  app.use(
    "/api/auth/",
    authRouter(
      options.identityNotification,
      options.identityEncryptionKey ??
        (env.IDENTITY_ENCRYPTION_KEY
          ? Buffer.from(env.IDENTITY_ENCRYPTION_KEY, "base64")
          : undefined),
    ),
  );
  app.use("/api/organizations", tenantRouter(options.resolveTxt));
  app.use("/api/platform", platformRouter);
  app.use("/api/billing", billingRouter(options.paymentProvider));
  app.get("/api/invitations", authenticate, async (req, res) => {
    res.json(await invitations.inbox(req.userId));
  });
  app.post("/api/invitations/:id/accept", authenticate, async (req, res) => {
    res.json(await invitations.accept(req.userId, String(req.params.id)));
  });
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", mailProvisioning: "pending-phase-6" });
  });
  app.get("/api/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready", mailReady: false });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  if (options.staticAssets) {
    app.use(
      express.static(options.staticAssets, {
        dotfiles: "deny",
        index: false,
        maxAge: 0,
        setHeaders: (res, path) => {
          res.setHeader(
            "Cache-Control",
            /[\\/]assets[\\/]/.test(path)
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          );
        },
      }),
    );
    app.use((req, res, next) => {
      if (
        ["GET", "HEAD"].includes(req.method) &&
        !req.path.startsWith("/api") &&
        !req.path.includes(".") &&
        req.accepts("html")
      ) {
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile("index.html", { root: options.staticAssets });
      } else next();
    });
  }
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
export default createApp();
