import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

/** Deliberately small loopback test peer, never an application mail server. */
async function peer(mode: "recipients" | "disconnect-after-data") {
  let dataCommands = 0;
  let completedData = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let inData = false;
    socket.write("220 synthetic.test ESMTP fixture\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line !== ".") continue;
          completedData++;
          inData = false;
          if (mode === "disconnect-after-data") socket.destroy();
          else socket.write("250 2.0.0 synthetic queue accepted\r\n");
        } else if (/^(EHLO|HELO) /i.test(line)) {
          socket.write("250 synthetic.test\r\n");
        } else if (/^MAIL FROM:/i.test(line)) {
          socket.write("250 2.1.0 sender accepted\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          socket.write(
            line.includes("temporary@")
              ? "450 4.2.0 synthetic temporary recipient failure\r\n"
              : line.includes("permanent@")
                ? "550 5.1.1 synthetic unknown recipient\r\n"
                : "250 2.1.5 recipient accepted\r\n",
          );
        } else if (line === "DATA") {
          dataCommands++;
          inData = true;
          socket.write("354 end with dot\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else if (line === "RSET") socket.write("250 reset\r\n");
        else socket.write("500 unsupported fixture command\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: address.port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 2000,
    greetingTimeout: 2000,
    socketTimeout: 2000,
    logger: false,
    debug: false,
  });
  return {
    transport,
    counts: () => ({ dataCommands, completedData }),
    close: async () => {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
const message = {
  from: "sender@synthetic.test",
  subject: "Synthetic protocol fixture",
  text: "No external delivery.",
};

test("SMTP partial RCPT acceptance retains 450/550 failures without retrying accepted recipients", async () => {
  const fixture = await peer("recipients");
  try {
    const result = await fixture.transport.sendMail({
      ...message,
      to: [
        "accepted@synthetic.test",
        "temporary@synthetic.test",
        "permanent@synthetic.test",
      ],
    });
    assert.deepEqual(result.accepted, ["accepted@synthetic.test"]);
    assert.deepEqual(result.rejected, [
      "temporary@synthetic.test",
      "permanent@synthetic.test",
    ]);
    assert.deepEqual(
      result.rejectedErrors?.map((error) => error.responseCode),
      [450, 550],
    );
    assert.deepEqual(fixture.counts(), { dataCommands: 1, completedData: 1 });
  } finally {
    await fixture.close();
  }
});

test("SMTP all-recipient temporary/permanent rejection sends no DATA and makes no automatic retry", async () => {
  const fixture = await peer("recipients");
  try {
    for (const [recipient, code] of [
      ["temporary", 450],
      ["permanent", 550],
    ] as const) {
      await assert.rejects(
        fixture.transport.sendMail({
          ...message,
          to: `${recipient}@synthetic.test`,
        }),
        (error: unknown) => {
          const failure = error as { responseCode?: number; command?: string };
          return failure.responseCode === code && failure.command === "RCPT TO";
        },
      );
    }
    assert.deepEqual(fixture.counts(), { dataCommands: 0, completedData: 0 });
  } finally {
    await fixture.close();
  }
});

test("SMTP loss after DATA remains ambiguous and is not resubmitted by the transport", async () => {
  const fixture = await peer("disconnect-after-data");
  try {
    await assert.rejects(
      fixture.transport.sendMail({ ...message, to: "accepted@synthetic.test" }),
    );
    assert.deepEqual(fixture.counts(), { dataCommands: 1, completedData: 1 });
  } finally {
    await fixture.close();
  }
});

test("standard delayed and failed DSNs remain MIME reports rather than proof that a send may be replayed", async () => {
  for (const [action, status] of [
    ["delayed", "4.2.0"],
    ["failed", "5.1.1"],
  ] as const) {
    const parsed = await simpleParser(
      Buffer.from(
        [
          "From: MAILER-DAEMON@synthetic.test",
          "To: sender@synthetic.test",
          "MIME-Version: 1.0",
          "Content-Type: multipart/report; report-type=delivery-status; boundary=synthetic",
          "",
          "--synthetic",
          "Content-Type: text/plain",
          "",
          `Synthetic delivery ${action}.`,
          "--synthetic",
          "Content-Type: message/delivery-status",
          "",
          "Reporting-MTA: dns; synthetic.test",
          "",
          "Final-Recipient: rfc822; recipient@synthetic.test",
          `Action: ${action}`,
          `Status: ${status}`,
          "",
          "--synthetic--",
          "",
        ].join("\r\n"),
      ),
    );
    assert.match(parsed.text ?? "", new RegExp(`delivery ${action}`));
    assert.match(parsed.text ?? "", new RegExp(`Action: ${action}`));
    assert.match(
      parsed.text ?? "",
      new RegExp(`Status: ${status.replaceAll(".", "\\.")}`),
    );
  }
});
