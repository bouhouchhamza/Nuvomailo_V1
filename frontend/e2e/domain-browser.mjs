import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preview } from "vite";

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chrome = chromeCandidates.find((path) => {
  try {
    return process.getBuiltinModule("node:fs").existsSync(path);
  } catch {
    return false;
  }
});
if (!chrome) throw new Error("A local Chromium browser is required");

const userData = await mkdtemp(join(tmpdir(), "nuvomailo-domain-e2e-"));
if (!resolve(userData).startsWith(resolve(tmpdir())))
  throw new Error("Unsafe browser profile path");
const port = 9333;
const server = await preview({
  root: resolve(import.meta.dirname, ".."),
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

let socket;
try {
  let target;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      target = targets.find((item) => item.type === "page");
      if (target) break;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!target) throw new Error("Browser debugging endpoint did not start");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const handlers = new Map();
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (data.id) {
      const waiter = pending.get(data.id);
      if (waiter) {
        pending.delete(data.id);
        data.error
          ? waiter.reject(new Error(data.error.message))
          : waiter.resolve(data.result);
      }
      return;
    }
    for (const handler of handlers.get(data.method) ?? [])
      Promise.resolve(handler(data.params)).catch((error) => {
        throw error;
      });
  });
  const call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolveCall, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, handler) =>
    handlers.set(method, [...(handlers.get(method) ?? []), handler]);

  const orgId = "11111111-1111-4111-8111-111111111111";
  let domain = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "release.example.test",
    verification_status: "verified",
    verification_attempts: 1,
    verification_expires_at: "2026-10-22T00:00:00Z",
    last_attempt_at: null,
    dnsChallenge: { type: "TXT", name: "_proof", value: "proof" },
    mailReadiness: "not-configured",
    mail_ever_activated: false,
    revalidation_state: "warning",
    revalidation_grace_expires_at: "2026-11-14T00:00:00Z",
  };
  let revalidated = false,
    releaseBody;
  const json = (value) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  on("Fetch.requestPaused", async ({ requestId, request }) => {
    const { pathname } = new URL(request.url);
    let status = 200,
      body = {};
    if (pathname === "/api/auth/refresh")
      body = {
        user: {
          id: "33333333-3333-4333-8333-333333333333",
          email: "owner@example.test",
          created_at: "2026-10-15T00:00:00Z",
        },
        accessToken: "synthetic-browser-token",
        expiresIn: 900,
      };
    else if (pathname === "/api/organizations")
      body = [
        {
          id: orgId,
          name: "Browser Domain Lab",
          slug: "browser-domain-lab",
          role: "owner",
          created_at: "2026-10-15T00:00:00Z",
        },
      ];
    else if (pathname === `/api/organizations/${orgId}/domains`)
      body = domain ? [domain] : [];
    else if (pathname === `/api/organizations/${orgId}/mailboxes`) body = [];
    else if (pathname === `/api/organizations/${orgId}/members`)
      body = [
        {
          id: "33333333-3333-4333-8333-333333333333",
          email: "owner@example.test",
          role: "owner",
        },
      ];
    else if (pathname.endsWith("/revalidate")) {
      revalidated = true;
      domain = {
        ...domain,
        revalidation_state: "current",
        revalidation_grace_expires_at: null,
      };
      body = domain;
    } else if (pathname.endsWith("/release")) {
      releaseBody = JSON.parse(request.postData ?? "{}");
      domain = null;
      body = {
        released: true,
        nameReusable: true,
        dnsChanged: false,
        mailDataDeleted: false,
      };
    } else {
      status = 404;
      body = { error: `Unexpected synthetic route ${pathname}` };
    }
    await call("Fetch.fulfillRequest", {
      requestId,
      responseCode: status,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: json(body),
    });
  });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Fetch.enable", {
    patterns: [{ urlPattern: "*://127.0.0.1:4173/api/*" }],
  });
  await call("Page.navigate", { url: "http://127.0.0.1:4173/" });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          "Browser evaluation failed",
      );
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error(
      `Timed out waiting for ${label}; releaseCalled=${Boolean(releaseBody)}; page=${String(await evaluate("document.body.innerText")).slice(-1000)}`,
    );
  };
  const click = (label) =>
    evaluate(
      `(() => { const node=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}); if(!node)return false; node.click(); return true; })()`,
    );
  const fill = (label, value) =>
    evaluate(
      `(() => { const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(label)})); const node=label?.querySelector('input,select'); if(!node)return false; const setter=Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set; setter.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
    );
  const typeReleaseField = async (kind, value) => {
    const focused = await evaluate(`(() => {
      const submit=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Release empty domain');
      const form=submit?.closest('form');
      const node=${JSON.stringify(kind)}==='password'
        ? form?.querySelector('input[type=password]')
        : form?.querySelector('input:not([type=password])');
      if(!node)return false;
      node.focus();
      return document.activeElement===node;
    })()`);
    if (!focused) return false;
    await call("Input.insertText", { text: value });
    await waitFor(
      `(() => {
      const submit=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Release empty domain');
      const form=submit?.closest('form');
      const node=${JSON.stringify(kind)}==='password'
        ? form?.querySelector('input[type=password]')
        : form?.querySelector('input:not([type=password])');
      return node?.value===${JSON.stringify(value)};
    })()`,
      `${kind} release field`,
    );
    return true;
  };

  await waitFor(
    `document.body.innerText.includes('Browser Domain Lab')`,
    "workspace",
  );
  if (!(await click("Domains"))) throw new Error("Domains tab missing");
  await waitFor(
    `document.body.innerText.includes('Revalidation: warning')`,
    "warning state",
  );
  if (!(await click("Revalidate DNS ownership")))
    throw new Error("Revalidation action missing");
  await waitFor(
    `document.body.innerText.includes('Revalidation: current')`,
    "current state",
  );
  if (!revalidated) throw new Error("Revalidation API was not called");
  if (!(await click("Prepare domain release")))
    throw new Error("Release action missing");
  if (!(await typeReleaseField("confirmation", "release.example.test")))
    throw new Error("Confirmation input missing");
  if (!(await typeReleaseField("password", "SyntheticBrowserPassword123!")))
    throw new Error("Password input missing");
  if (!(await fill("Reason", "test-claim")))
    throw new Error("Reason input missing");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  const settledValues = await evaluate(
    `([...document.querySelectorAll('input,select')].map(node=>node.value))`,
  );
  if (
    !settledValues.includes("release.example.test") ||
    !settledValues.includes("SyntheticBrowserPassword123!") ||
    !settledValues.includes("test-claim")
  )
    throw new Error(
      `Controlled release fields did not settle: ${JSON.stringify(settledValues)}`,
    );
  const releaseState = await evaluate(
    `(() => { const node=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Release empty domain'); const form=node?.closest('form'); return {found:!!node,disabled:node?.disabled,valid:form?.checkValidity(),fields:[...(form?.querySelectorAll('input,select')??[])].map(item=>({value:item.value,valid:item.checkValidity(),message:item.validationMessage}))}; })()`,
  );
  if (!releaseState.found || releaseState.disabled || !releaseState.valid)
    throw new Error(
      `Release form is not submittable: ${JSON.stringify(releaseState)}`,
    );
  if (!(await click("Release empty domain")))
    throw new Error("Release submit missing");
  await waitFor(
    `document.body.innerText.includes('No domains yet')`,
    "released state",
  );
  await waitFor(
    `![...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Release empty domain')`,
    "release form removal",
  );
  if (
    releaseBody?.confirmName !== "release.example.test" ||
    releaseBody?.dashboardPassword !== "SyntheticBrowserPassword123!" ||
    releaseBody?.reason !== "test-claim"
  )
    throw new Error("Release request was not exact");
  if (
    await evaluate(
      `document.body.innerText.includes('SyntheticBrowserPassword123!') || [...document.querySelectorAll('input')].some(node=>node.value==='SyntheticBrowserPassword123!')`,
    )
  )
    throw new Error("Release password remained in the rendered DOM");
  console.log(
    JSON.stringify({
      passed: [
        "production-bundle-rendered-in-chromium",
        "warning-revalidation-request-and-reload",
        "owner-release-exact-confirmation-and-password",
        "release-password-removed-from-dom",
        "released-domain-removed-after-api-success",
      ],
    }),
  );
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill();
  await Promise.race([
    new Promise((resolveExit) => browser.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3000)),
  ]);
  await server.httpServer.close();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(userData, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}
