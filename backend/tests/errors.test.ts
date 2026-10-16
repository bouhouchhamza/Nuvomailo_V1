import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { errorHandler } from "../src/middlewares/errors.js";
test("unexpected errors are sanitized and request size is bounded", async () => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/test", () => {
    throw new Error("private database credentials");
  });
  app.use(errorHandler);
  const result = await request(app).post("/test").send({});
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "Internal server error" });
  assert.equal(
    (
      await request(app)
        .post("/test")
        .send({ large: "x".repeat(2048) })
    ).status,
    413,
  );
});
