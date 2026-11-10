// lib/email.ts against a tiny FAKE SMTP server on 127.0.0.1 (nothing leaves this machine, no real mail is sent). It proves, with the installed
// nodemailer, that: the five variable names the code reads are the ones that matter (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD /
// EMAIL_FROM_ADDRESS), the login uses SMTP_USER + SMTP_PASSWORD, the sender is EMAIL_FROM_ADDRESS (falling back to SMTP_USER), and a missing
// variable makes sendEmail return false (a failed notification) instead of throwing.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";

const USER = "sender-test@example.invalid";
const PASS = "test-only-password-123";
const FROM = "no-reply-test@example.invalid";

interface Seen { authUser?: string; authPass?: string; mailFrom?: string; rcpt: string[]; data: string; messages: number }
const seen: Seen = { rcpt: [], data: "", messages: 0 };
let server: net.Server;
let port = 0;

function handle(socket: net.Socket) {
  let buffer = "";
  let inData = false;
  let authStep: "none" | "user" | "pass" = "none";
  const send = (line: string) => socket.write(line + "\r\n");
  send("220 fake-smtp ready");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        seen.data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        seen.messages += 1;
        send("250 queued (fake)");
        continue;
      }
      const nl = buffer.indexOf("\r\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (authStep === "user") { seen.authUser = Buffer.from(line, "base64").toString(); authStep = "pass"; send("334 UGFzc3dvcmQ6"); continue; }
      if (authStep === "pass") { seen.authPass = Buffer.from(line, "base64").toString(); authStep = "none"; send("235 ok"); continue; }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) { socket.write("250-fake-smtp\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n"); }
      else if (cmd.startsWith("AUTH PLAIN")) { const [, user, pass] = Buffer.from(line.split(" ")[2] ?? "", "base64").toString().split("\0"); seen.authUser = user; seen.authPass = pass; send("235 ok"); }
      else if (cmd.startsWith("AUTH LOGIN")) { authStep = "user"; send("334 VXNlcm5hbWU6"); }
      else if (cmd.startsWith("MAIL FROM:")) { seen.mailFrom = line.slice(10).replace(/[<>\s]/g, "").split(" ")[0]; send("250 ok"); }
      else if (cmd.startsWith("RCPT TO:")) { seen.rcpt.push(line.slice(8).replace(/[<>\s]/g, "")); send("250 ok"); }
      else if (cmd === "DATA") { inData = true; send("354 go ahead"); }
      else if (cmd === "QUIT") { send("221 bye"); socket.end(); }
      else send("250 ok");
    }
  });
  socket.on("error", () => {});
}

before(async () => {
  for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM_ADDRESS"]) delete process.env[k];
  server = net.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => { server?.close(); });

test("with SMTP variables missing, sendEmail returns false (a failed notification) and does not throw, and nothing is sent", async () => {
  const { sendEmail } = await import("../src/lib/email");
  const errors: unknown[] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    assert.equal(await sendEmail({ to: "x@example.invalid", subject: "s", text: "t", html: "<p>t</p>" }), false);
  } finally {
    console.error = saved;
  }
  assert.ok(errors.length > 0, "the missing configuration is logged");
  assert.equal(seen.messages, 0);
});

test("with the five correct variable names set, the message reaches the SMTP server with the right login and sender", async () => {
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_USER = USER;
  process.env.SMTP_PASSWORD = PASS;
  process.env.EMAIL_FROM_ADDRESS = FROM;
  const { sendEmail } = await import("../src/lib/email");
  assert.equal(await sendEmail({ to: "customer@example.invalid", subject: "Hello", text: "plain body", html: "<p>html body</p>" }), true);
  assert.equal(seen.messages, 1);
  assert.equal(seen.authUser, USER, "logs in with SMTP_USER");
  assert.equal(seen.authPass, PASS, "logs in with SMTP_PASSWORD");
  assert.equal(seen.mailFrom, FROM, "the envelope sender is EMAIL_FROM_ADDRESS");
  assert.deepEqual(seen.rcpt, ["customer@example.invalid"]);
  assert.match(seen.data, new RegExp(`From: .*${FROM.replace(/\./g, "\\.")}`));
  assert.match(seen.data, /Subject: Hello/);
});
