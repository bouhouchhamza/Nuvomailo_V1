import { Router } from "express";
import { authenticate } from "../middlewares/auth.js";
import * as billing from "../services/billing.service.js";
export function billingRouter(provider?: billing.PaymentProvider) {
  const router = Router();
  router.use(authenticate);
  router.get("/plans", async (_req, res) => {
    res.json({
      plans: await billing.catalog(),
      mode: "sandbox",
      livePayments: false,
    });
  });
  router.get("/:orgId", async (req, res) => {
    res.json({
      ...(await billing.overview(req.userId, String(req.params.orgId))),
      providerAvailable: !!provider,
    });
  });
  router.post("/:orgId/checkout", async (req, res) => {
    res
      .status(201)
      .json(
        await billing.checkout(
          req.userId,
          String(req.params.orgId),
          req.body,
          provider,
        ),
      );
  });
  router.post("/:orgId/cancel", async (req, res) => {
    await billing.cancel(req.userId, String(req.params.orgId));
    res.sendStatus(204);
  });
  return router;
}
