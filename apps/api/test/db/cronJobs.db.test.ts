/**
 * The 03:00 AMC expiry job and the 03:30 ticket escalation job, called through the REAL app with the shared secret, against the real test database:
 * a valid call runs the handler and answers 200 with its summary, and the escalation job's rules (windows, retry, once per level) keep their own
 * coverage in ticketAdmin.db.test.ts and amcContracts.db.test.ts.
 *
 * SAFETY: refuses to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database (localhost:5434/platino_test).
 * It writes nothing itself. No e-mail / WhatsApp is configured in the test environment, so nothing can be sent.
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const ISOLATED = { hosts: ["localhost", "127.0.0.1"], port: "5434", database: "platino_test" };
function pointsAtIsolatedDb(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return ISOLATED.hosts.includes(u.hostname) && u.port === ISOLATED.port && u.pathname === `/${ISOLATED.database}`;
  } catch {
    return false;
  }
}
const isolated = pointsAtIsolatedDb(process.env.DATABASE_URL) && pointsAtIsolatedDb(process.env.DIRECT_URL) && !!process.env.JWT_SECRET;
const skip = isolated ? false : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";

describe("cron jobs: AMC expiry and ticket escalation through the real app", { skip }, () => {
  let server: Server;
  let base = "";
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["CRON_SECRET", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "NODE_ENV", "VERCEL"];
  const SECRET = "cron-db-test-secret";

  before(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[k];
    process.env.CRON_SECRET = SECRET;
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.ADMIN_WEB_URL = "https://admin.platino.example";
    const warn = console.warn;
    console.warn = () => {};
    const mod = await import("../../src/index");
    console.warn = warn;
    await new Promise<void>((resolve) => { server = mod.default.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server?.close();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    const { prisma } = await import("../../src/lib/prisma");
    await prisma.$disconnect();
  });

  const call = (path: string, auth?: string) => fetch(`${base}${path}`, { headers: auth ? { authorization: auth } : {} });

  test("escalation job: without the secret it is refused; with it the handler runs and answers 200 with its summary", async () => {
    assert.equal((await call("/complaints/cron/escalate")).status, 401);
    assert.equal((await call("/complaints/cron/escalate", "Bearer nope")).status, 401);
    const ok = await call("/complaints/cron/escalate", `Bearer ${SECRET}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    for (const k of ["checked", "escalatedToRegional", "escalatedToManagement", "deferred"]) assert.equal(typeof body[k], "number", k);
  });

  test("AMC expiry job: without the secret it is refused; with it the handler runs and answers 200 with its summary", async () => {
    assert.equal((await call("/amc-orders/send-expiry-reminders")).status, 401);
    assert.equal((await call("/amc-orders/send-expiry-reminders", "Bearer nope")).status, 401);
    const ok = await call("/amc-orders/send-expiry-reminders", `Bearer ${SECRET}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    for (const k of ["remindersSent", "vendorRemindersSent", "recipients"]) assert.equal(typeof body[k], "number", k);
  });
});
