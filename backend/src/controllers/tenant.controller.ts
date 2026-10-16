import type { Request, Response } from "express";
import * as service from "../services/tenant.service.js";
export const list = async (req: Request, res: Response) => {
  res.json(await service.listOrganizations(req.userId));
};
export const create = async (req: Request, res: Response) => {
  res.status(201).json(await service.createOrganization(req.userId, req.body));
};
export const get = async (req: Request<{ orgId: string }>, res: Response) => {
  res.json(await service.getOrganization(req.userId, req.params.orgId));
};
export const update = async (
  req: Request<{ orgId: string }>,
  res: Response,
) => {
  res.json(
    await service.updateOrganization(req.userId, req.params.orgId, req.body),
  );
};
export const members = async (
  req: Request<{ orgId: string }>,
  res: Response,
) => {
  res.json(await service.listMembers(req.userId, req.params.orgId));
};
export const invite = async (
  req: Request<{ orgId: string }>,
  res: Response,
) => {
  res
    .status(201)
    .json(await service.inviteMember(req.userId, req.params.orgId, req.body));
};
export const changeMember = async (
  req: Request<{ orgId: string; userId: string }>,
  res: Response,
) => {
  res.json(
    await service.updateMember(
      req.userId,
      req.params.orgId,
      req.params.userId,
      req.body,
    ),
  );
};
export const removeMember = async (
  req: Request<{ orgId: string; userId: string }>,
  res: Response,
) => {
  await service.updateMember(req.userId, req.params.orgId, req.params.userId);
  res.sendStatus(204);
};
