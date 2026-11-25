// The public POST /vendors/register is limited per client address (10 per hour), like the other unauthenticated endpoints. The real router is used;
// the database is replaced by stubs (vendor lookups/creates) and by the in-memory stand-in for the IpRateLimit table, so nothing real is touched.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createFakeRateLimitStore } from "./helpers/fakeRateLimitStore";

const store = createFakeRateLimitStore();
let server: Server;
let base = "";
let created = 0;
let n = 0;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  store.install(prisma);
  Object.defineProperty(prisma, "vendor", {
    configurable: true,
    value: {
      findUnique: async () => null,
      create: async ({ data }: any) => { created++; return { id: `v${created}`, name: data.name, status: data.status }; },
    },
  });
  const { vendorsRouter } = await import("../src/routes/vendors");
  const app = express();
  app.set("trust proxy", true); // each request carries its own X-Forwarded-For
  app.use(express.json());
  app.use("/vendors", vendorsRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
beforeEach(() => { store.reset(); created = 0; });

const body = () => ({ name: `Vendor ${++n}`, contactName: "Test Person", contactEmail: `vendor${n}@example.invalid`, contactPhone: "9876543210", address: "1 Test Road" });
const register = (ip: string, payload: unknown = body()) =>
  fetch(`${base}/vendors/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(payload) });

test("the first 10 registrations from one address in the hour are accepted; the 11th is refused with 429 and Retry-After, and nothing is created", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await register("203.0.113.10")).status, 201, `request ${i + 1}`);
  assert.equal(created, 10);
  const r = await register("203.0.113.10");
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: "Too many attempts. Please try again later." });
  assert.ok(Number(r.headers.get("retry-after")) >= 1, "tells the caller when to retry");
  assert.equal(created, 10, "the refused request created no vendor");
});

test("another address is not affected by the first address's limit", async () => {
  for (let i = 0; i < 11; i++) await register("203.0.113.20");
  assert.equal((await register("203.0.113.20")).status, 429);
  assert.equal((await register("203.0.113.21")).status, 201);
});

test("invalid submissions count towards the limit too (so the endpoint cannot be probed freely), and are answered 400 until then", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await register("203.0.113.30", { name: "" })).status, 400);
  assert.equal((await register("203.0.113.30", { name: "" })).status, 429);
  assert.equal(created, 0);
});

test("when the shared counter store is unavailable the endpoint still works and is still limited (per-process fallback)", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    store.failing = true;
    for (let i = 0; i < 10; i++) assert.equal((await register("203.0.113.40")).status, 201);
    assert.equal((await register("203.0.113.40")).status, 429);
  } finally {
    console.warn = warn;
  }
});
