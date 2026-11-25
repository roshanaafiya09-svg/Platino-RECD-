// lib/email.ts must not wait indefinitely for an SMTP server. The transport options carry explicit timeouts, and - with the installed nodemailer -
// a server that accepts the connection but never speaks makes sendMail reject within the greeting timeout (sendEmail turns that rejection into
// `false`). Only a fake server on 127.0.0.1 is used; nothing is sent anywhere.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { SMTP_TIMEOUTS_MS } from "../src/lib/email";

const sockets: net.Socket[] = [];
const silent = net.createServer((s) => { sockets.push(s); s.on("error", () => {}); /* accepts, never greets */ });
after(() => { for (const s of sockets) s.destroy(); silent.close(); });

test("the SMTP timeouts are set and are short enough for a request/serverless function", () => {
  for (const [name, ms] of Object.entries(SMTP_TIMEOUTS_MS)) {
    assert.ok(Number.isInteger(ms) && ms >= 1_000 && ms <= 30_000, `${name} = ${ms}`);
  }
  assert.deepEqual(Object.keys(SMTP_TIMEOUTS_MS).sort(), ["connectionTimeout", "greetingTimeout", "socketTimeout"]);
});

test("a server that never greets makes the send fail within the greeting timeout instead of hanging", async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const port = (silent.address() as AddressInfo).port;
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" }, ...SMTP_TIMEOUTS_MS });
  const started = Date.now();
  await assert.rejects(transport.sendMail({ from: "a@example.invalid", to: "b@example.invalid", subject: "s", text: "t" }));
  const took = Date.now() - started;
  assert.ok(took < SMTP_TIMEOUTS_MS.greetingTimeout + 3_000, `rejected after ${took} ms`);
  transport.close();
});
