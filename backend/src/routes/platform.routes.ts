import { Router } from "express";
import { authenticate } from "../middlewares/auth.js";
import * as platform from "../services/platform.service.js";
import * as support from "../services/support-grant.service.js";
import * as incidents from "../services/incident.service.js";
export const platformRouter = Router();
platformRouter.use(authenticate);
platformRouter.get("/incidents", async (req, res) => {
  res.json(await incidents.list(req.userId, req.sessionId));
});
platformRouter.post("/incidents", async (req, res) => {
  res
    .status(201)
    .json(await incidents.open(req.userId, req.sessionId, req.body));
});
platformRouter.patch("/incidents/:id", async (req, res) => {
  res.json(
    await incidents.transition(
      req.userId,
      req.sessionId,
      String(req.params.id),
      req.body,
    ),
  );
});
platformRouter.get("/support/:grantId", async (req, res) => {
  res.json(
    await support.diagnostics(
      req.userId,
      req.sessionId,
      String(req.params.grantId),
    ),
  );
});
platformRouter.get("/health", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await platform.operationalHealth(req.userId, req.sessionId));
});
platformRouter.get("/plans", async (req, res) => {
  res.json(await platform.catalog(req.userId, req.sessionId));
});
platformRouter.put("/plans/:id", async (req, res) => {
  res.json(
    await platform.updatePlan(
      req.userId,
      req.sessionId,
      String(req.params.id),
      req.body,
    ),
  );
});
platformRouter.post("/queue/:id/retry", async (req, res) => {
  res
    .status(202)
    .json(
      await platform.retryJob(
        req.userId,
        req.sessionId,
        String(req.params.id),
        req.body,
      ),
    );
});
platformRouter.get("/access", async (req, res) => {
  res.json({ role: await platform.requireStaff(req.userId, req.sessionId) });
});
platformRouter.get("/organizations", async (req, res) => {
  res.json(await platform.directory(req.userId, req.sessionId, req.query));
});
platformRouter.get("/organizations/:id", async (req, res) => {
  res.json(
    await platform.detail(req.userId, req.sessionId, String(req.params.id)),
  );
});
platformRouter.get("/queue", async (req, res) => {
  res.json(await platform.queue(req.userId, req.sessionId));
});
platformRouter.get("/audit", async (req, res) => {
  res.json(await platform.events(req.userId, req.sessionId));
});
platformRouter.patch("/organizations/:id/status", async (req, res) => {
  res.json(
    await platform.setStatus(
      req.userId,
      req.sessionId,
      "organization",
      String(req.params.id),
      req.body,
    ),
  );
});
platformRouter.patch("/accounts/:id/status", async (req, res) => {
  res.json(
    await platform.setStatus(
      req.userId,
      req.sessionId,
      "account",
      String(req.params.id),
      req.body,
    ),
  );
});
