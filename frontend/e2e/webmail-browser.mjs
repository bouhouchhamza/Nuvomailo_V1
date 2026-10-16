import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preview } from "vite";

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
if (!chrome) throw new Error("A local Chromium browser is required");
const userData = await mkdtemp(join(tmpdir(), "nuvomailo-webmail-e2e-"));
if (!resolve(userData).startsWith(resolve(tmpdir())))
  throw new Error("Unsafe browser profile path");
const debugPort = 9334;
const server = await preview({
  root: resolve(import.meta.dirname, ".."),
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
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
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
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
      void Promise.resolve(handler(data.params));
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
  const mailboxId = "22222222-2222-4222-8222-222222222222";
  let sendCalls = 0;
  const sendBodies = [];
  let draftBody;
  let contacts = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      displayName: "Pilot recipient",
      email: "recipient@tenant-a.lab.invalid",
    },
  ];
  let attempts = [
    {
      id: "66666666-6666-4666-8666-666666666666",
      state: "uncertain",
      resolution: null,
      resolvedAt: null,
      sentCopyStored: null,
      acceptedRecipientCount: null,
      rejectedRecipientCount: null,
      createdAt: "2026-10-15T10:00:00.000Z",
      finishedAt: "2026-10-15T10:00:01.000Z",
    },
  ];
  const json = (value) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  on("Fetch.requestPaused", async ({ requestId, request }) => {
    const url = new URL(request.url);
    const { pathname } = url;
    let status = 200;
    let body = {};
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
          name: "Browser Webmail Lab",
          slug: "browser-webmail-lab",
          role: "owner",
          created_at: "2026-10-15T00:00:00Z",
        },
      ];
    else if (pathname === `/api/organizations/${orgId}/domains`) body = [];
    else if (pathname === `/api/organizations/${orgId}/mailboxes`)
      body = [{ id: mailboxId }];
    else if (pathname === `/api/organizations/${orgId}/members`) body = [];
    else if (pathname === "/api/webmail")
      body = {
        mode: "local-lab",
        mailboxes: [
          {
            id: mailboxId,
            address: "pilot@tenant-a.lab.invalid",
            permission: "write",
          },
        ],
      };
    else if (pathname === "/api/webmail/connect") body = {};
    else if (pathname === "/api/webmail/folders")
      body = [{ path: "INBOX" }, { path: "Drafts" }, { path: "Sent" }];
    else if (pathname === "/api/webmail/contacts" && request.method === "GET")
      body = contacts;
    else if (pathname === "/api/webmail/contacts") {
      const value = JSON.parse(request.postData ?? "{}");
      const saved = {
        id: "55555555-5555-4555-8555-555555555555",
        displayName: value.displayName,
        email: value.email,
      };
      contacts = [...contacts, saved];
      body = saved;
    } else if (pathname === "/api/webmail/send-attempts") body = attempts;
    else if (
      pathname.startsWith("/api/webmail/send-attempts/") &&
      pathname.endsWith("/resolve")
    ) {
      const id = pathname.split("/").at(-2);
      const value = JSON.parse(request.postData ?? "{}");
      attempts = attempts.map((attempt) =>
        attempt.id === id
          ? {
              ...attempt,
              resolution: value.resolution,
              resolvedAt: "2026-10-15T11:00:02.000Z",
            }
          : attempt,
      );
      body = { id, resolution: value.resolution };
    }
    else if (pathname === "/api/webmail/messages")
      body = {
        uidValidity: "5",
        nextBeforeUid: null,
        items: [
          {
            uid: 2,
            subject: "Re: Browser thread",
            seen: false,
            threadId: "thread-browser",
            threadDepth: 1,
            visibleThreadSize: 2,
          },
          {
            uid: 1,
            subject: "Browser thread",
            seen: true,
            threadId: "thread-browser",
            threadDepth: 0,
            visibleThreadSize: 2,
          },
        ],
      };
    else if (pathname === "/api/webmail/draft") {
      draftBody = JSON.parse(request.postData ?? "{}");
      body = {
        smtpAccepted: false,
        sentCopyStored: false,
        draftSaved: true,
      };
    } else if (pathname === "/api/webmail/send") {
      sendCalls++;
      sendBodies.push(JSON.parse(request.postData ?? "{}"));
      if (sendCalls === 1) {
        status = 503;
        attempts = [
          {
            ...attempts[0],
            id: "77777777-7777-4777-8777-777777777777",
            createdAt: "2026-10-15T11:00:00.000Z",
            resolution: null,
            resolvedAt: null,
          },
          ...attempts,
        ];
        body = { error: "Send outcome is uncertain; inspect Sent" };
      } else {
        attempts = [
          {
            id: "88888888-8888-4888-8888-888888888888",
            state: "accepted",
            resolution: null,
            resolvedAt: null,
            sentCopyStored: true,
            acceptedRecipientCount: 1,
            rejectedRecipientCount: 1,
            createdAt: "2026-10-15T12:00:00.000Z",
            finishedAt: "2026-10-15T12:00:01.000Z",
          },
          ...attempts,
        ];
        body = {
          smtpAccepted: true,
          sentCopyStored: true,
          draftSaved: false,
          acceptedRecipientCount: 1,
          rejectedRecipientCount: 1,
          replayed: true,
        };
      }
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
  await call("Accessibility.enable");
  await call("Fetch.enable", {
    patterns: [{ urlPattern: "*://127.0.0.1:4174/api/*" }],
  });
  await call("Page.navigate", { url: "http://127.0.0.1:4174/" });
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
      `Timed out waiting for ${label}; page=${String(await evaluate("document.body.innerText")).slice(-1200)}`,
    );
  };
  const click = (label) =>
    evaluate(
      `(() => { const node=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}); if(!node)return false; node.click(); return true; })()`,
    );
  const fill = (label, value) =>
    evaluate(
      `(() => { const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(label)})); const node=label?.querySelector('input,textarea,select'); if(!node)return false; const prototype=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
    );
  await waitFor(
    `document.body.innerText.includes('Browser Webmail Lab')`,
    "workspace",
  );
  if (!(await click("Webmail"))) throw new Error("Webmail tab missing");
  if (!(await click("Load mailbox access")))
    throw new Error("Mailbox access action missing");
  await waitFor(
    `document.body.innerText.includes('Assigned mailbox')`,
    "mailbox access",
  );
  await fill("Assigned mailbox", mailboxId);
  await fill("Mailbox password", "SyntheticBrowserMailbox123!");
  if (!(await click("Connect mailbox")))
    throw new Error("Connect action missing");
  await waitFor(
    `document.body.innerText.includes('Thread: Re: Browser thread (2 messages shown)')`,
    "threaded listing",
  );
  await waitFor(
    `document.body.innerText.includes('this attempt will not be submitted automatically again')`,
    "persisted uncertain attempt",
  );
  if (!(await click("Use recipient@tenant-a.lab.invalid")))
    throw new Error("Contact action missing");
  await fill("Subject", "Browser durable send");
  await fill("Message", "Synthetic browser body");
  const attached = await evaluate(`(() => {
    const input=[...document.querySelectorAll('input[type=file]')][0];
    if(!input)return false;
    const transfer=new DataTransfer();
    transfer.items.add(new File(['synthetic attachment'],'browser.txt',{type:'text/plain'}));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set.call(input,transfer.files);
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  if (!attached) throw new Error("Attachment control missing");
  await waitFor(
    `document.body.innerText.includes('browser.txt')`,
    "attachment selection",
  );
  if (!(await click("Save draft"))) throw new Error("Draft action missing");
  await waitFor(
    `document.body.innerText.includes('Draft saved.')`,
    "draft saved",
  );
  if (!(await click("Send"))) throw new Error("Send action missing");
  await waitFor(
    `document.body.innerText.includes('Send outcome is uncertain')`,
    "uncertain outcome",
  );
  if (!(await click("I checked Sent; this message is not there")))
    throw new Error("Reconciliation action missing");
  await waitFor(
    `document.body.innerText.includes('Attempt marked as not found in Sent') && [...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='Send' && !node.disabled)`,
    "durable uncertain-send resolution",
  );
  if (!(await click("Send"))) throw new Error("Second send action missing");
  await waitFor(
    `document.body.innerText.includes('1 recipient(s) were rejected')`,
    "partial replay warning",
  );
  if (
    draftBody?.attachments?.[0]?.filename !== "browser.txt" ||
    draftBody?.to?.[0] !== "recipient@tenant-a.lab.invalid"
  )
    throw new Error("Draft did not preserve recipient and attachment");
  if (
    sendBodies.length !== 2 ||
    !sendBodies[0]?.idempotencyKey ||
    !sendBodies[1]?.idempotencyKey ||
    sendBodies[0].idempotencyKey === sendBodies[1].idempotencyKey
  )
    throw new Error("Explicit reconciliation did not create a fresh send key");
  if (
    await evaluate(
      `document.body.innerText.includes('SyntheticBrowserMailbox123!') || [...document.querySelectorAll('input')].some(node=>node.value==='SyntheticBrowserMailbox123!')`,
    )
  )
    throw new Error("Mailbox password remained in the rendered DOM");
  const accessibility = await call("Accessibility.getFullAXTree");
  const unnamedControls = accessibility.nodes
    .filter(
      (node) =>
        !node.ignored &&
        ["button", "textbox", "combobox", "checkbox"].includes(
          node.role?.value,
        ) &&
        !String(node.name?.value ?? "").trim(),
    )
    .map((node) => node.role?.value);
  if (unnamedControls.length)
    throw new Error(`Unnamed accessible controls: ${unnamedControls.join(",")}`);
  if (
    !(await evaluate(
      `document.documentElement.lang==='en' && document.querySelectorAll('main').length===1 && !!document.querySelector('nav[aria-label="Workspace"]')`,
    ))
  )
    throw new Error("Page landmarks or language are incomplete");
  await evaluate(
    `(() => { const node=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Webmail'); node?.focus(); return document.activeElement===node; })()`,
  );
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
  if (
    !(await evaluate(
      `document.activeElement && document.activeElement !== document.body && document.activeElement.textContent.trim() !== 'Webmail'`,
    ))
  )
    throw new Error("Keyboard focus did not advance from workspace navigation");
  console.log(
    JSON.stringify({
      passed: [
        "production-bundle-rendered-in-chromium",
        "reference-thread-grouping",
        "content-free-uncertain-attempt-after-reload",
        "contact-recipient-and-attachment-draft",
        "explicit-new-key-after-uncertain-send",
        "partial-acceptance-warning",
        "mailbox-password-removed-from-dom",
        "native-accessibility-tree-and-keyboard-navigation",
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
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rm(userData, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 49) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
}
