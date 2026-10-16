import { test, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { requestContext } from "../src/middlewares/request-context.js";
test("request logging uses a generated correlation ID and excludes paths, query values, bodies and bearer credentials", async () => {
  const lines: string[] = [];
  const capture = mock.method(process.stdout, "write", (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.post("/sensitive/:id", (_req, res) => {
      res.json({ ok: true });
    });
    const response = await request(app)
      .post("/sensitive/private-resource-marker?token=private-query-marker")
      .set("Authorization", "Bearer private-bearer-marker")
      .set("X-Request-Id", "private-client-id-marker")
      .send({ password: "private-password-marker" });
    assert.equal(response.status, 200);
    const entry = JSON.parse(
      lines.find((line) => line.includes("http.completed"))!,
    );
    assert.equal(entry.route, "/sensitive/:id");
    assert.equal(entry.requestId, response.headers["x-request-id"]);
    for (const marker of [
      "private-resource-marker",
      "private-query-marker",
      "private-bearer-marker",
      "private-client-id-marker",
      "private-password-marker",
    ])
      assert.equal(lines.join("").includes(marker), false);
  } finally {
    capture.mock.restore();
  }
});
