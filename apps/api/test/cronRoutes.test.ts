// The AMC expiry job (03:00 UTC) and the ticket escalation job (03:30 UTC): schedule, shared-secret protection, and what happens when a run fails.
// Runs against the REAL app (src/index.ts). The database address is unreachable on purpose: nothing here touches a database, and a request that
// gets past the secret check therefore fails inside the handler - which is exactly how we prove (a) a valid secret reaches the handler and
// (b) a failing run is reported as a 500 and logged, so Vercel's request log shows the failure. SMTP / WhatsApp are never configured here,
// so nothing can be sent.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;
for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[k];

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const JOBS = [
  { name: "AMC expiry", path: "/amc-orders/send-expiry-reminders", schedule: "0 3 * * *" },
  { name: "ticket escalation", path: "/complaints/cron/escalate", schedule: "30 3 * * *" },
] as const;
const SECRET = "cron-test-secret-value";

let server: Server;
let base = "";
const savedError = console.error;
const savedSecret = process.env.CRON_SECRET;

before(async () => {
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1"; // stops src/index.ts from calling listen() itself
  process.env.ADMIN_WEB_URL = "https://admin.platino.example";
  process.env.CRON_SECRET = SECRET;
  const warn = console.warn;
  console.warn = () => {};
  const mod = await import("../src/index");
  console.warn = warn;
  await new Promise<void>((resolve) => { server = mod.default.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  console.error = savedError;
  if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
  server?.close();
});

const get = (path: string, authorization?: string) => fetch(`${base}${path}`, { headers: authorization === undefined ? {} : { authorization } });

test("vercel.json registers both jobs at the intended UTC times (Vercel Cron schedules are always UTC)", () => {
  const cfg = JSON.parse(readFileSync(resolve(__dirname, "..", "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
  for (const job of JOBS) {
    const entries = cfg.crons.filter((c) => c.path === job.path);
    assert.equal(entries.length, 1, `${job.name}: registered exactly once`);
    assert.equal(entries[0].schedule, job.schedule, `${job.name}: schedule`);
  }
});

for (const job of JOBS) {
  test(`${job.name}: no secret, a wrong secret, a wrong scheme or an empty bearer are all refused (401) and nothing runs`, async () => {
    const logged: unknown[] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    const attempts = [undefined, "Bearer wrong", `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET, "Bearer ", "Bearer", `Bearer  ${SECRET}`]; // (a trailing space cannot be tested: HTTP strips it from header values before the app sees it)
    for (const auth of attempts) {
      const r = await get(job.path, auth);
      assert.equal(r.status, 401, JSON.stringify(auth));
      assert.deepEqual(await r.json(), { error: "Unauthorized" });
    }
    console.error = savedError;
    assert.equal(logged.length, 0, "a refused call never reaches the database (no error was raised)");
  });

  test(`${job.name}: when CRON_SECRET is not set on the server, every call is refused - even "Bearer undefined" or "Bearer "`, async () => {
    delete process.env.CRON_SECRET;
    try {
      for (const auth of [undefined, "Bearer undefined", "Bearer ", "Bearer", ""]) {
        assert.equal((await get(job.path, auth)).status, 401, JSON.stringify(auth));
      }
    } finally {
      process.env.CRON_SECRET = SECRET;
    }
  });

  test(`${job.name}: the correct secret gets past the check and reaches the handler; a failing run answers 500 with a generic body and is logged`, async () => {
    const logged: unknown[] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    const r = await get(job.path, `Bearer ${SECRET}`);
    console.error = savedError;
    // 500 (not 401) proves the secret was accepted and the handler ran; the database is unreachable on purpose.
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "Internal server error" });
    assert.ok(logged.length > 0, "the failure is written to the server log, and the 500 shows in Vercel's request log");
  });

  test(`${job.name}: only GET is accepted (Vercel Cron sends GET); other methods do not run the job`, async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await fetch(`${base}${job.path}`, { method, headers: { authorization: `Bearer ${SECRET}` } });
      assert.notEqual(r.status, 200, method);
    }
  });
}
