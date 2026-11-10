// The shared cron helpers (src/lib/cronAuth.ts): the secret check and the one-line run log.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorisedCron, logCronRun } from "../src/lib/cronAuth";

const SECRET = "a-long-random-cron-secret-value";

function withSecret<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = value;
  try { return fn(); } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
}

test("isAuthorisedCron: only the exact 'Bearer <secret>' header passes", () => {
  withSecret(SECRET, () => {
    assert.equal(isAuthorisedCron(`Bearer ${SECRET}`), true);
    for (const bad of [undefined, "", "Bearer", "Bearer ", `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET, `Bearer ${SECRET}x`, `Bearer x${SECRET}`, `Bearer ${SECRET.slice(0, -1)}`, "Bearer wrong-secret-of-same-length!!!"]) {
      assert.equal(isAuthorisedCron(bad), false, JSON.stringify(bad));
    }
  });
});

test("isAuthorisedCron: fails closed when CRON_SECRET is unset or empty", () => {
  for (const value of [undefined, ""]) {
    withSecret(value, () => {
      for (const header of [undefined, "", "Bearer ", "Bearer undefined", "Bearer null"]) assert.equal(isAuthorisedCron(header), false, `${JSON.stringify(value)} / ${JSON.stringify(header)}`);
    });
  }
});

test("logCronRun writes ONE JSON line with the job, ok, duration and numeric / boolean counters only - never text, names or ids", () => {
  const lines: string[] = [];
  const saved = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    logCronRun("service-reminders", Date.now() - 5, { sent: 3, failed: 0, enabled: true, ticketNumber: "T-123", email: "someone@example.com", nested: { a: 1 }, nothing: null });
  } finally {
    console.log = saved;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.cron, "service-reminders");
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.ms, "number");
  assert.equal(parsed.sent, 3);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.enabled, true);
  for (const leaked of ["ticketNumber", "email", "nested", "nothing"]) assert.equal(leaked in parsed, false, `${leaked} must not be logged`);
  assert.doesNotMatch(lines[0], /someone@example\.com|T-123/);
});
