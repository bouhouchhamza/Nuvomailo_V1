import type { Request, Response } from "express";
import * as service from "../services/operations.service.js";
type TenantRequest = Request<{
  orgId: string;
  requestId: string;
  mailboxId: string;
}>;
export const audit = async (req: TenantRequest, res: Response) => {
  res.json(await service.listAudit(req.userId, req.params.orgId, req.query));
};
export const requests = async (req: TenantRequest, res: Response) => {
  res.json(await service.listRequests(req.userId, req.params.orgId, req.query));
};
export const retry = async (req: TenantRequest, res: Response) => {
  res
    .status(202)
    .json(
      await service.retryRequest(
        req.userId,
        req.params.orgId,
        req.params.requestId,
      ),
    );
};
export const reconcile = async (req: TenantRequest, res: Response) => {
  res
    .status(202)
    .json(
      await service.reconcileMailbox(
        req.userId,
        req.params.orgId,
        req.params.mailboxId,
      ),
    );
};
