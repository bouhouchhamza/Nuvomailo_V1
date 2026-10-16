import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { performance } from "node:perf_hooks";
import { log } from "../observability/logger.js";
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}
export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const start = performance.now();
  res.on("finish", () =>
    log("info", "http.completed", {
      requestId: req.requestId,
      method: req.method,
      route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
      status: res.statusCode,
      durationMs: Math.round(performance.now() - start),
    }),
  );
  next();
};
