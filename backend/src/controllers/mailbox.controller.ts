import type { Request, Response } from "express";
import * as service from "../services/mailbox.service.js";
type MailboxRequest = Request<{ orgId: string; mailboxId: string }>;
export const list = async (req: MailboxRequest, res: Response) => {
  res.json(await service.listMailboxes(req.userId, req.params.orgId));
};
export const get = async (req: MailboxRequest, res: Response) => {
  res.json(
    await service.getMailbox(
      req.userId,
      req.params.orgId,
      req.params.mailboxId,
    ),
  );
};
export const create = async (req: MailboxRequest, res: Response) => {
  res
    .status(202)
    .json(await service.createMailbox(req.userId, req.params.orgId, req.body));
};
export const update = async (req: MailboxRequest, res: Response) => {
  res
    .status(202)
    .json(
      await service.updateMailbox(
        req.userId,
        req.params.orgId,
        req.params.mailboxId,
        req.body,
      ),
    );
};
