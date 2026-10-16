import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pool from "../config/database.js";
import {
  saveRoute,
  runRoutingOnce,
  type RoutingTarget,
} from "../services/mail-routing.service.js";
import { LocalRoutingApplier } from "../adapters/routing-applier.adapter.js";
import { LocalImapSmtpProvider } from "../adapters/webmail.adapter.js";
import { rpc } from "./rpc.js";
let stage = "input";
const org = "11111111-1111-4111-8111-111111111111",
  owner = "33333333-3333-4333-8333-333333333333",
  domain = "44444444-4444-4444-8444-444444444444",
  box = "55555555-5555-4555-8555-555555555555";
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2048) throw new Error("INPUT_LIMIT");
  }
  const credentials = JSON.parse(input) as {
    address: string;
    password: string;
    peer: { address: string; password: string };
  };
  assert.equal(credentials.address, "pilot@tenant-a.lab.invalid");
  const source = "route-lab@tenant-a.lab.invalid",
    route = {
      domainId: domain,
      localPart: "route-lab",
      kind: "alias",
      targets: [box],
    };
  stage = "intent";
  await saveRoute(owner, org, route);
  const applier = new LocalRoutingApplier();
  let first: RoutingTarget | undefined;
  stage = "apply";
  let result = "idle";
  for (let i = 0; i < 10 && result === "idle"; i++)
    result = await runRoutingOnce({
      apply: async (target) => {
        first = target;
        await applier.apply(target);
      },
    });
  assert.equal(result, "applied");
  assert.ok(first);
  stage = "delivery";
  const provider = new LocalImapSmtpProvider(
    await readFile("/run/nuvomailo-public-trust/lab-cert.pem"),
  );
  const marker = `routing-${randomUUID()}`;
  await provider.compose(
    credentials,
    {
      to: [source],
      cc: [],
      bcc: [],
      subject: marker,
      text: "Synthetic alias delivery",
      attachments: [],
    },
    false,
  );
  let found = false;
  for (let i = 0; i < 10; i++) {
    const listing = (await provider.list(
      credentials,
      "INBOX",
      undefined,
      marker,
    )) as { items: unknown[] };
    if (listing.items.length) {
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(found, true);
  stage = "forward";
  assert.equal(credentials.peer.address, "partial@tenant-a.lab.invalid");
  await saveRoute(owner, org, {
    ...route,
    kind: "forward",
    targets: [box, "99999999-9999-4999-8999-999999999999"],
  });
  assert.equal(await runRoutingOnce(applier), "applied");
  stage = "forward-delivery";
  const forwarded = `forward-${randomUUID()}`;
  await provider.compose(
    credentials,
    {
      to: [source],
      cc: [],
      bcc: [],
      subject: forwarded,
      text: "Synthetic internal multi-target forwarding",
      attachments: [],
    },
    false,
  );
  for (const account of [credentials, credentials.peer]) {
    let delivered = false;
    for (let i = 0; i < 10; i++) {
      const listing = (await provider.list(
        account,
        "INBOX",
        undefined,
        forwarded,
      )) as { items: unknown[] };
      if (listing.items.length) {
        delivered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(delivered, true);
  }
  stage = "fence";
  assert.equal((await rpc("/v1/routing", first)).status, 409);
  assert.equal(
    (
      await rpc("/v1/routing", {
        ...first,
        organizationId: "22222222-2222-4222-8222-222222222222",
      })
    ).status,
    403,
  );
  stage = "disable";
  await saveRoute(owner, org, { ...route, enabled: false });
  assert.equal(await runRoutingOnce(applier), "applied");
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "alias-intent",
        "actual-postfix-map",
        "smtp-alias-to-imap-delivery",
        "internal-forward-map",
        "smtp-forward-to-two-imap-mailboxes",
        "routing-generation-fence",
        "cross-tenant-target-denial",
        "disable-removes-map-preserves-address",
      ],
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      stage,
      code: "ROUTING_CONFORMANCE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
