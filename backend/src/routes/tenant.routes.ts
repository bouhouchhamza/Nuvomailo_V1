import { Router } from "express";
import { authenticate } from "../middlewares/auth.js";
import * as controller from "../controllers/tenant.controller.js";
import * as domains from "../controllers/domain.controller.js";
import * as domainService from "../services/domain.service.js";
import * as mailboxes from "../controllers/mailbox.controller.js";
import * as operations from "../controllers/operations.controller.js";
import { resolveTxt, type TxtResolver } from "../services/domain.service.js";
import * as invitations from "../services/invitation.service.js";
import * as domainHealth from "../services/domain-health.service.js";
import { assignMailbox } from "../services/webmail.service.js";
import * as routing from "../services/mail-routing.service.js";
import { transferEmptyDomain } from "../services/domain-transfer.service.js";
import * as support from "../services/support-grant.service.js";
import { retainOrRestore } from "../services/mailbox-retention.service.js";
import * as usage from "../services/mailbox-usage.service.js";
export function tenantRouter(resolver: TxtResolver = resolveTxt) {
  const router = Router();
  router.use(authenticate);
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.post("/:orgId/mailboxes/:mailboxId/retention", async (req, res) => {
    res
      .status(202)
      .json(
        await retainOrRestore(
          req.userId,
          String(req.params.orgId),
          String(req.params.mailboxId),
          req.body,
        ),
      );
  });
  router.get("/:orgId/mailboxes/:mailboxId/usage", async (req, res) => {
    res.json(
      await usage.status(
        req.userId,
        String(req.params.orgId),
        String(req.params.mailboxId),
      ),
    );
  });
  router.get("/:orgId/usage-summary", async (req, res) => {
    res.json(
      await usage.organizationUsage(req.userId, String(req.params.orgId)),
    );
  });
  router.post(
    "/:orgId/mailboxes/:mailboxId/usage-refresh",
    async (req, res) => {
      res
        .status(202)
        .json(
          await usage.requestRefresh(
            req.userId,
            String(req.params.orgId),
            String(req.params.mailboxId),
          ),
        );
    },
  );
  router.get("/:orgId/support-grants", async (req, res) => {
    res.json(await support.list(req.userId, String(req.params.orgId)));
  });
  router.post("/:orgId/support-grants", async (req, res) => {
    res
      .status(201)
      .json(
        await support.issue(
          req.userId,
          req.sessionId,
          String(req.params.orgId),
          req.body,
        ),
      );
  });
  router.delete("/:orgId/support-grants/:grantId", async (req, res) => {
    await support.revoke(
      req.userId,
      String(req.params.orgId),
      String(req.params.grantId),
    );
    res.sendStatus(204);
  });
  router.get("/:orgId/invitations", async (req, res) => {
    res.json(
      await invitations.listInvitations(req.userId, String(req.params.orgId)),
    );
  });
  router.post("/:orgId/invitations", async (req, res) => {
    res
      .status(201)
      .json(
        await invitations.invite(
          req.userId,
          String(req.params.orgId),
          req.body,
        ),
      );
  });
  router.delete("/:orgId/invitations/:invitationId", async (req, res) => {
    await invitations.revoke(
      req.userId,
      String(req.params.orgId),
      String(req.params.invitationId),
    );
    res.sendStatus(204);
  });
  router.post("/:orgId/transfer-ownership", async (req, res) => {
    await invitations.transfer(req.userId, String(req.params.orgId), req.body);
    res.sendStatus(204);
  });
  router.post("/:orgId/leave", async (req, res) => {
    await invitations.leave(req.userId, String(req.params.orgId));
    res.sendStatus(204);
  });
  router.get("/:orgId", controller.get);
  router.patch("/:orgId", controller.update);
  router.get("/:orgId/members", controller.members);
  router.post("/:orgId/members", controller.invite);
  router.patch("/:orgId/members/:userId", controller.changeMember);
  router.delete("/:orgId/members/:userId", controller.removeMember);
  router.get("/:orgId/domains", domains.list);
  router.post("/:orgId/domains/:domainId/transfer", async (req, res) => {
    res.json(
      await transferEmptyDomain(
        req.userId,
        String(req.params.orgId),
        String(req.params.domainId),
        req.body,
      ),
    );
  });
  router.get("/:orgId/domains/:domainId/health", async (req, res) => {
    res.json(
      await domainHealth.health(
        req.userId,
        String(req.params.orgId),
        String(req.params.domainId),
      ),
    );
  });
  router.post("/:orgId/domains/:domainId/revalidate", async (req, res) => {
    res.json(
      await domainService.revalidateDomain(
        req.userId,
        String(req.params.orgId),
        String(req.params.domainId),
        resolver,
      ),
    );
  });
  router.post("/:orgId/domains/:domainId/release", async (req, res) => {
    res.json(
      await domainService.releaseEmptyDomain(
        req.userId,
        req.sessionId,
        String(req.params.orgId),
        String(req.params.domainId),
        req.body,
      ),
    );
  });
  router.post("/:orgId/domains/:domainId/lifecycle", async (req, res) => {
    res.json(
      await domainHealth.lifecycle(
        req.userId,
        String(req.params.orgId),
        String(req.params.domainId),
        req.body,
      ),
    );
  });
  router.post("/:orgId/domains", domains.create);
  router.post("/:orgId/domains/:domainId/verify", domains.verify(resolver));
  router.post("/:orgId/domains/:domainId/challenge", domains.renew);
  router.get("/:orgId/mailboxes", mailboxes.list);
  router.get("/:orgId/mail-routes", async (req, res) => {
    res.json(await routing.listRoutes(req.userId, String(req.params.orgId)));
  });
  router.put("/:orgId/mail-routes", async (req, res) => {
    res
      .status(202)
      .json(
        await routing.saveRoute(req.userId, String(req.params.orgId), req.body),
      );
  });
  router.put("/:orgId/mailboxes/:mailboxId/access", async (req, res) => {
    await assignMailbox(
      req.userId,
      String(req.params.orgId),
      String(req.params.mailboxId),
      req.body,
    );
    res.sendStatus(204);
  });
  router.post("/:orgId/mailboxes", mailboxes.create);
  router.get("/:orgId/mailboxes/:mailboxId", mailboxes.get);
  router.patch("/:orgId/mailboxes/:mailboxId", mailboxes.update);
  router.get("/:orgId/audit-events", operations.audit);
  router.get("/:orgId/provisioning-requests", operations.requests);
  router.post(
    "/:orgId/provisioning-requests/:requestId/retry",
    operations.retry,
  );
  router.post("/:orgId/mailboxes/:mailboxId/reconcile", operations.reconcile);
  return router;
}
