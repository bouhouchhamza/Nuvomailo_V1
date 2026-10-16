import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { log } from "../observability/logger.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res,
  _next,
) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Invalid request",
      issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    code?: string;
    status?: number;
    type?: string;
  };
  if (e.code === "23505") {
    res.status(409).json({ error: "Resource already exists" });
    return;
  }
  if (e.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  if (e.status === 413) {
    res.status(413).json({ error: "Request too large" });
    return;
  }
  log("error", "http.failed", {
    requestId: req.requestId,
    code: "INTERNAL_ERROR",
  });
  res.status(500).json({ error: "Internal server error" });
};
