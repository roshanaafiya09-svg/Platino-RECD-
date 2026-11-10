// Request-level error answers (src/lib/errorHandler.ts) on the REAL app: unknown URLs, oversized / wrongly encoded bodies.
// (Malformed JSON and genuine 500s are covered in malformedJson.test.ts.) The database address is unreachable on purpose; nothing here needs a database.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let server: Server;
let base = "";

before(async () => {
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1";
  process.env.ADMIN_WEB_URL = "https://admin.platino.example";
  const warn = console.warn;
  console.warn = () => {};
  const mod = await import("../src/index");
  console.warn = warn;
  await new Promise<void>((resolve) => { server = mod.default.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

test("an unknown URL answers 404 in JSON (not Express's HTML page), for any method", async () => {
  for (const [method, path] of [["GET", "/nope"], ["POST", "/no/such/route"], ["DELETE", "/customers-typo"]] as const) {
    const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(await r.json(), { error: "Not found" });
  }
});

test("real routes are not shadowed by the 404 handler: /health answers and protected routes still say 401", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/customers`)).status, 401);
});

test("a body over the 10 MB limit answers 413 with a fixed message", async () => {
  const big = JSON.stringify({ photo: "x".repeat(11 * 1024 * 1024) });
  const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "Request body too large" });
});

test("an unsupported Content-Encoding answers 415, an unsupported charset answers 415", async () => {
  const enc = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "x-unknown" }, body: "{}" });
  assert.equal(enc.status, 415);
  assert.deepEqual(await enc.json(), { error: "Unsupported content encoding" });
  const cs = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json; charset=latin1" }, body: "{}" });
  assert.equal(cs.status, 415);
  assert.deepEqual(await cs.json(), { error: "Unsupported character set" });
});
