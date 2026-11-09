// Malformed JSON request bodies answer 400 (the caller's mistake), while genuine server errors still answer 500.
// Runs against the REAL app exported by src/index.ts. The database address is unreachable on purpose: nothing here touches a database,
// and the "genuine server error" case is exactly a database that cannot be reached.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { apiErrorHandler } from "../src/lib/errorHandler";

let server: Server;
let base = "";
const savedError = console.error;

before(async () => {
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1"; // stops src/index.ts from calling listen() itself
  process.env.ADMIN_WEB_URL = "https://admin.platino.example";
  const warn = console.warn;
  console.warn = () => {};
  const mod = await import("../src/index");
  console.warn = warn;
  await new Promise<void>((resolve) => { server = mod.default.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { console.error = savedError; server?.close(); });

const post = (path: string, body: string | undefined, contentType: string | null = "application/json", headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", body, headers: { ...(contentType ? { "Content-Type": contentType } : {}), ...headers } });

const MALFORMED_BODIES = ["{bad", '{"email": "a@b.example", "password": }', "not json at all", '{"email":"a@b.example",', "[1,2", "{'single': 'quotes'}"];

test("malformed JSON -> 400 with a fixed message, on public and protected routes alike", async () => {
  for (const path of ["/auth/login", "/public/complaints", "/customers", "/orders"]) {
    for (const body of MALFORMED_BODIES) {
      const r = await post(path, body);
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.deepEqual(await r.json(), { error: "Invalid JSON in request body" });
    }
  }
});

test("the 400 for malformed JSON reveals nothing: no stack, no parser message, no echo of what was sent", async () => {
  const secretish = "hunter2-do-not-echo";
  const r = await post("/auth/login", `{"password": "${secretish}", oops`);
  assert.equal(r.status, 400);
  const text = await r.text();
  assert.equal(text.includes(secretish), false, "the request body is never echoed back");
  assert.doesNotMatch(text, /SyntaxError|Unexpected|position|JSON\.parse|body-parser|node_modules|\bat \w+/i);
  assert.equal(r.headers.get("content-type")?.startsWith("application/json"), true);
});

test("valid JSON is still processed normally: the route's own validation answers (400 with its usual shape), not the malformed-JSON message", async () => {
  const r = await post("/auth/login", JSON.stringify({ email: "not-an-email" }));
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: unknown };
  assert.notEqual(body.error, "Invalid JSON in request body");
  assert.equal(typeof body.error, "object", "zod's flattened field errors, unchanged");
});

test("authentication is unchanged: valid JSON without a token is still 401 on a protected route", async () => {
  const r = await post("/customers", JSON.stringify({ name: "x" }));
  assert.equal(r.status, 401);
});

test("empty body: with and without a JSON content type it is handled by the route's validation (400), never a 500", async () => {
  for (const [body, ct] of [[undefined, "application/json"], ["", "application/json"], [undefined, null]] as const) {
    const r = await post("/auth/login", body, ct);
    assert.equal(r.status, 400);
    assert.notEqual(((await r.json()) as { error: unknown }).error, "Invalid JSON in request body");
  }
});

test("wrong content type: JSON text sent as text/plain or form data is not parsed as JSON, so the route's validation answers (400), never a 500", async () => {
  for (const ct of ["text/plain", "application/x-www-form-urlencoded"]) {
    const r = await post("/auth/login", JSON.stringify({ email: "a@b.example", password: "x" }), ct);
    assert.equal(r.status, 400, ct);
  }
  // malformed text under a non-JSON type is simply not parsed: also the route's validation, not a parse error
  const r = await post("/auth/login", "{bad", "text/plain");
  assert.equal(r.status, 400);
  assert.notEqual(((await r.json()) as { error: unknown }).error, "Invalid JSON in request body");
});

test("a genuine server error still answers 500 with the generic message (valid JSON, database unreachable)", async () => {
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  const r = await post("/auth/login", JSON.stringify({ email: "someone@platino.example", password: "a-valid-looking-password" }));
  console.error = savedError;
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "Internal server error" });
  assert.ok(logged.length > 0, "server errors are still logged for the operator");
});

test("handler unit: an ordinary Error is a 500 (logged, generic body); a body-parser parse failure is a 400 (not logged)", () => {
  const make = () => {
    const out: { status?: number; body?: unknown; sent?: boolean } = {};
    const res = { headersSent: false, status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
    return { out, res };
  };
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const a = make();
    apiErrorHandler(new Error("secret internal detail"), {} as never, a.res as never, (() => { throw new Error("next must not be called"); }) as never);
    assert.equal(a.out.status, 500);
    assert.deepEqual(a.out.body, { error: "Internal server error" });
    assert.equal(logged.length, 1);

    const b = make();
    const parseErr = Object.assign(new SyntaxError("Unexpected token"), { type: "entity.parse.failed", status: 400, statusCode: 400 });
    apiErrorHandler(parseErr, {} as never, b.res as never, (() => { throw new Error("next must not be called"); }) as never);
    assert.equal(b.out.status, 400);
    assert.equal(logged.length, 1, "a client mistake is not logged as a server error");

    // a plain SyntaxError thrown by application code is NOT a malformed request body: it stays a 500
    const c = make();
    apiErrorHandler(new SyntaxError("bug in our code"), {} as never, c.res as never, (() => { throw new Error("next must not be called"); }) as never);
    assert.equal(c.out.status, 500);

    // once a response has started, the error is handed on to Express's default handling
    let handedOn: unknown;
    const d = make();
    d.res.headersSent = true;
    const err = new Error("late");
    apiErrorHandler(err, {} as never, d.res as never, ((e: unknown) => { handedOn = e; }) as never);
    assert.equal(handedOn, err);
    assert.equal(d.out.status, undefined);
  } finally {
    console.error = savedError;
  }
});
