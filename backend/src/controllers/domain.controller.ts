import type { Request, Response } from "express";
import * as service from "../services/domain.service.js";
type DomainRequest = Request<{ orgId: string; domainId: string }>;
export const list = async (req: DomainRequest, res: Response) => {
  res.json(await service.listDomains(req.userId, req.params.orgId));
};
export const create = async (req: DomainRequest, res: Response) => {
  res
    .status(201)
    .json(await service.createDomain(req.userId, req.params.orgId, req.body));
};
export const renew = async (req: DomainRequest, res: Response) => {
  res.json(
    await service.renewChallenge(
      req.userId,
      req.params.orgId,
      req.params.domainId,
    ),
  );
};
export const verify =
  (resolver: service.TxtResolver) =>
  async (req: DomainRequest, res: Response) => {
    res.json(
      await service.verifyDomain(
        req.userId,
        req.params.orgId,
        req.params.domainId,
        resolver,
      ),
    );
  };
