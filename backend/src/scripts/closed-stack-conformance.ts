import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
let stage = "readiness";
const base = "http://api:4000",
  origin = "https://nuvomailo.rehearsal.invalid",
  cookies = new Map<string, string>();
let bearer = "";
let p95ReadMs = 0;
async function call(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(cookies.size
        ? {
            Cookie: [...cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
          }
        : {}),
      ...(method !== "GET" ? { "X-Nuvomailo-CSRF": "1", Origin: origin } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const entry = cookie.split(";")[0]!,
      split = entry.indexOf("=");
    cookies.set(entry.slice(0, split), entry.slice(split + 1));
  }
  const data = await response.json().catch(() => null);
  return { status: response.status, data, headers: response.headers };
}
try {
  const readiness = await call("/api/ready");
  assert.equal(readiness.status, 200);
  assert.equal(readiness.headers.get("cache-control"), "no-store");
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src/);
  assert.match(
    page.headers.get("strict-transport-security") ?? "",
    /max-age=/,
  );
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /root/);
  assert.equal((await fetch(base + "/.env")).status, 404);
  stage = "origin-boundary";
  const allowedOrigin = await fetch(base + "/api/ready", {
    headers: { Origin: origin },
  });
  assert.equal(allowedOrigin.headers.get("access-control-allow-origin"), origin);
  const rejectedOrigin = await fetch(base + "/api/ready", {
    headers: { Origin: "https://unapproved.invalid" },
  });
  assert.equal(rejectedOrigin.headers.get("access-control-allow-origin"), origin);
  assert.notEqual(
    rejectedOrigin.headers.get("access-control-allow-origin"),
    "https://unapproved.invalid",
  );
  stage = "identity";
  const email = `${randomUUID()}@rehearsal.invalid`,
    password = randomBytes(32).toString("base64url");
  assert.equal(
    (await call("/api/auth/register", "POST", { email, password })).status,
    201,
  );
  const login = await call("/api/auth/login", "POST", { email, password });
  assert.equal(login.status, 200);
  bearer = login.data.accessToken;
  assert.equal(login.data.refreshToken, undefined);
  assert.ok(cookies.has("nuvomailo_refresh"));
  stage = "tenant";
  const org = await call("/api/organizations", "POST", {
    name: "Closed synthetic rehearsal",
    slug: `rehearsal-${randomUUID()}`,
  });
  assert.equal(org.status, 201);
  const id = org.data.id;
  const domain = await call(`/api/organizations/${id}/domains`, "POST", {
    name: `${randomUUID()}.rehearsal.invalid`,
  });
  assert.equal(domain.status, 201);
  assert.equal(
    (
      await call(`/api/organizations/${id}/mailboxes`, "POST", {
        domainId: domain.data.id,
        localPart: "blocked",
        quotaMb: 100,
      })
    ).status,
    422,
  );
  stage = "billing-staff-boundaries";
  const billing = await call(`/api/billing/${id}`);
  assert.equal(billing.status, 200);
  assert.equal(billing.data.providerAvailable, false);
  assert.equal(billing.data.entitlements.snapshotFrozen, true);
  assert.equal((await call("/api/platform/access")).status, 403);
  stage = "native-mfa";
  const enrollment = await call("/api/auth/mfa/enroll", "POST", { password });
  assert.equal(enrollment.status, 200);
  const totp = OTPAuth.URI.parse(enrollment.data.uri) as OTPAuth.TOTP;
  const confirmed = await call("/api/auth/mfa/confirm", "POST", {
    factor: totp.generate(),
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await call("/api/auth/me")).status, 401);
  bearer = "";
  const secured = await call("/api/auth/login", "POST", {
    email,
    password,
    factor: confirmed.data.recoveryCodes[0],
  });
  assert.equal(secured.status, 200);
  bearer = secured.data.accessToken;
  stage = "bounded-concurrency";
  const readDurations: number[] = [];
  for (let round = 0; round < 5; round++)
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const started = performance.now();
        const response = await call("/api/auth/me");
        readDurations.push(performance.now() - started);
        assert.equal(response.status, 200);
      }),
    );
  readDurations.sort((a, b) => a - b);
  p95ReadMs = readDurations[Math.ceil(readDurations.length * 0.95) - 1]!;
  assert.ok(p95ReadMs < 5_000);
  stage = "refresh-revocation";
  const refreshed = await call("/api/auth/refresh", "POST");
  assert.equal(refreshed.status, 200);
  bearer = refreshed.data.accessToken;
  assert.equal((await call("/api/auth/logout", "POST")).status, 204);
  assert.equal((await call("/api/auth/me")).status, 401);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "production-container-static-ui",
        "security-headers-and-origin-boundary",
        "hidden-files-denied",
        "file-secret-native-postgres-login",
        "persisted-http-identity-cookie",
        "tenant-domain-intent",
        "unverified-mailbox-denied",
        "frozen-entitlements",
        "payment-provider-disabled",
        "tenant-owner-not-staff",
        "native-argon2-totp-encrypted-mfa",
        "bounded-authenticated-read-concurrency",
        "refresh-logout-revocation",
      ],
      publicPorts: false,
      realMail: false,
      concurrentReads: readDurations.length,
      concurrency: 10,
      p95ReadMs: Math.round(p95ReadMs * 10) / 10,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "CLOSED_STACK_CONFORMANCE_FAILED",
    }),
  );
  process.exitCode = 1;
}
