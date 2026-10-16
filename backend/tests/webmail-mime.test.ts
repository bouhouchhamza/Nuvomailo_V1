import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import {
  addThreadMetadata,
  compileMail,
  parseReferenceHeader,
  safeMailHtml,
} from "../src/adapters/webmail.adapter.js";

test("compiled MIME hides Bcc recipients and preserves attachments", async () => {
  const built = await compileMail("sender@tenant-a.lab.invalid", {
    to: ["to@tenant-a.lab.invalid"],
    cc: ["cc@tenant-a.lab.invalid"],
    bcc: ["private@tenant-b.lab.invalid"],
    subject: "Synthetic MIME",
    text: "Synthetic body",
    attachments: [
      {
        filename: "sample.txt",
        contentBase64: Buffer.from("synthetic attachment").toString("base64"),
      },
    ],
  });
  assert.doesNotMatch(built.message.toString(), /^bcc:/im);
  assert.doesNotMatch(
    built.message.toString(),
    /private@tenant-b\.lab\.invalid/,
  );
  const parsed = await simpleParser(built.message);
  assert.equal(parsed.subject, "Synthetic MIME");
  assert.equal(
    parsed.attachments[0]?.content.toString(),
    "synthetic attachment",
  );
  assert.equal(parsed.bcc, undefined);
  assert.ok(built.messageId);
});
test("mail HTML removes active content, tracking images and external navigation", () => {
  const safe = safeMailHtml(
    '<p onclick="alert(1)">Hello<strong> there</strong></p><script>secret()</script><img src="https://tracker.invalid/pixel"><a href="https://evil.invalid">link</a><style>body{display:none}</style><iframe src="https://evil.invalid"></iframe>',
  );
  assert.equal(safe, "<p>Hello<strong> there</strong></p>link");
});
test("private draft Bcc survives editing while submission removes it", async () => {
  const message = {
    to: ["to@tenant-a.lab.invalid"],
    cc: [],
    bcc: ["hidden@tenant-a.lab.invalid"],
    subject: "Synthetic draft",
    text: "draft",
    attachments: [],
  };
  const draft = await simpleParser(
    (await compileMail("sender@tenant-a.lab.invalid", message, true)).message,
  );
  assert.ok(draft.bcc);
  const sent = await simpleParser(
    (await compileMail("sender@tenant-a.lab.invalid", message, false)).message,
  );
  assert.equal(sent.bcc, undefined);
});
test("bounded threading uses References roots without merging equal subjects", () => {
  const references = parseReferenceHeader(
    Buffer.from(
      "References: <root@example.test>\r\n\t<parent@example.test>\r\nX-Test: ignored\r\n",
    ),
  );
  assert.deepEqual(references, [
    "<root@example.test>",
    "<parent@example.test>",
  ]);
  const rows = addThreadMetadata([
    { uid: 1, subject: "Same", messageId: "<root@example.test>" },
    {
      uid: 2,
      subject: "Re: Same",
      messageId: "<child@example.test>",
      inReplyTo: "<root@example.test>",
      references,
    },
    { uid: 3, subject: "Same", messageId: "<unrelated@example.test>" },
  ]);
  assert.equal(rows[0]?.threadId, rows[1]?.threadId);
  assert.equal(rows[0]?.visibleThreadSize, 2);
  assert.equal(rows[1]?.threadDepth, 2);
  assert.notEqual(rows[0]?.threadId, rows[2]?.threadId);
  assert.equal(rows[2]?.visibleThreadSize, 1);
});
