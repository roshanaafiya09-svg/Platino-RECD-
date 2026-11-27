// The signing credential (lib/signingSession.ts) and its gate (middleware/signingCredential.ts): the parts that need no database. The database-backed
// behaviour (live session, cancel, staff account standing, the route sweep) is in test/db/serviceReportsSigningCredential.db.test.ts.
process.env.JWT_SECRET = "test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVICE_REPORT_LIMITS } from "@recd/shared";
import { SIGNING_SESSION_TTL_MS, checkSigningSession, issueSigningCredential, issueSigningSession, newSigningSessionId, parseSigningCredential } from "../src/lib/signingSession";
import { SIGNING_CREDENTIAL_ROUTES, SIGNING_SCHEME, signingCredentialGate } from "../src/middleware/signingCredential";

const claims = { reportId: "sr1", version: 3, staffId: "staff1", tokenVersion: 2, sessionId: "sess-1" };
const T0 = 1_800_000_000_000;

test("a credential lasts exactly the signing-session time and carries the report, version, staff account, token version and session id", () => {
  const { token, expiresAt } = issueSigningCredential(claims, T0);
  assert.equal(expiresAt.getTime(), T0 + SIGNING_SESSION_TTL_MS);
  assert.equal(SIGNING_SESSION_TTL_MS, SERVICE_REPORT_LIMITS.SIGNING_SESSION_MINUTES * 60_000);
  const parsed = parseSigningCredential(token, T0 + 1000);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.claims, claims);
    assert.equal(parsed.expiresAt.getTime(), T0 + SIGNING_SESSION_TTL_MS);
  }
  assert.ok(parseSigningCredential(token, T0 + SIGNING_SESSION_TTL_MS).ok, "valid up to the last moment");
  assert.deepEqual(parseSigningCredential(token, T0 + SIGNING_SESSION_TTL_MS + 1), { ok: false, reason: "expired" });
});

test("session ids are random and unguessable", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newSigningSessionId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{24}$/);
});

test("forged, edited, truncated and malformed credentials are refused", () => {
  const { token } = issueSigningCredential(claims, T0);
  const [payload, mac] = token.split(".");
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), r: "sr2" })).toString("base64url");
  const later = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), e: T0 + 99 * SIGNING_SESSION_TTL_MS })).toString("base64url");
  for (const bad of [`${changed}.${mac}`, `${later}.${mac}`, `${payload}.${mac.slice(0, -2)}AA`, `${payload}.`, `.${mac}`, payload, "", "a.b.c", "not a token", `${token}x`, "x".repeat(5000)]) {
    const r = parseSigningCredential(bad, T0);
    assert.equal(r.ok, false, bad.slice(0, 20));
  }
});

test("a credential, a signing session and a login token can never stand in for one another", async () => {
  const cred = issueSigningCredential(claims, T0).token;
  const session = issueSigningSession({ reportId: "sr1", version: 3, staffId: "staff1" }, T0).token;
  // the old session is not a credential, and a credential is not an old session
  assert.equal(parseSigningCredential(session, T0).ok, false);
  assert.equal(checkSigningSession(cred, { reportId: "sr1", version: 3, staffId: "staff1" }, T0).ok, false);
  // a login token (a JWT) is not a credential
  const { signToken } = await import("../src/lib/jwt");
  assert.equal(parseSigningCredential(signToken({ userId: "u", roleKey: "x", customerId: null }), T0).ok, false);
  // another secret cannot mint a credential this server accepts
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "another-secret";
  const foreign = issueSigningCredential(claims, T0).token;
  process.env.JWT_SECRET = saved;
  assert.equal(parseSigningCredential(foreign, T0).ok, false);
});

test("the gate admits exactly three requests: GET signing-view, POST sign, POST signing-session/cancel", () => {
  assert.deepEqual(SIGNING_CREDENTIAL_ROUTES.map((r) => `${r.method} ${r.name}`), ["GET signing-view", "POST sign", "POST cancel"]);
  const ok = (m: string, p: string) => SIGNING_CREDENTIAL_ROUTES.some((r) => r.method === m && r.pattern.test(p));
  assert.ok(ok("GET", "/abc/signing-view") && ok("POST", "/abc/sign") && ok("POST", "/abc/signing-session/cancel"));
  for (const [m, p] of [
    ["GET", "/abc"], ["GET", "/"], ["GET", "/abc/pdf"], ["GET", "/abc/signature"], ["POST", "/abc/submit"], ["POST", "/abc/reopen"], ["POST", "/abc/signing-session"],
    ["PATCH", "/abc"], ["DELETE", "/abc"], ["POST", "/"], ["POST", "/abc/signing-view"], ["GET", "/abc/sign"], ["GET", "/abc/signing-session/cancel"],
    ["GET", "/abc/signing-view/"], ["GET", "/abc/def/signing-view"], ["HEAD", "/abc/signing-view"], ["POST", "/abc/sign/x"], ["GET", "/abc/SIGNING-VIEW"],
  ]) assert.equal(ok(m, p), false, `${m} ${p}`);
});

function run(headers: Record<string, string>, method: string, path: string) {
  return new Promise<{ status?: number; body?: any; nexted: boolean; req: any }>((resolveRun) => {
    const req: any = { headers, method, path };
    const res: any = {
      status(code: number) { this.code = code; return this; },
      json(body: unknown) { resolveRun({ status: this.code, body, nexted: false, req }); },
    };
    Promise.resolve(signingCredentialGate(req, res, () => resolveRun({ nexted: true, req }))).catch((e) => resolveRun({ status: 500, body: String(e), nexted: false, req }));
  });
}

test("gate: a request WITHOUT the signing scheme is passed on untouched (the normal login rules apply)", async () => {
  for (const headers of [{}, { authorization: "Bearer abc" }, { authorization: "signing abc" }, { authorization: "Basic abc" }, { authorization: "Signing" }]) {
    const r = await run(headers as any, "GET", "/sr1/signing-view");
    assert.equal(r.nexted, true, JSON.stringify(headers));
    assert.equal(r.req.signing, undefined);
    assert.equal(r.req.auth, undefined);
  }
});

test("gate: outside the three approved requests the answer is 403, before the credential is even looked at (valid or not)", async () => {
  const good = `${SIGNING_SCHEME}${issueSigningCredential({ ...claims, reportId: "sr1" }).token}`;
  for (const header of [good, `${SIGNING_SCHEME}garbage`]) {
    for (const [m, p] of [["GET", "/sr1"], ["GET", "/"], ["GET", "/sr1/pdf"], ["POST", "/sr1/submit"], ["POST", "/sr1/signing-session"], ["DELETE", "/sr1"], ["GET", "/sr1/sign"]]) {
      const r = await run({ authorization: header }, m, p);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.code, "SIGNING_CREDENTIAL_SCOPE");
      assert.equal(r.nexted, false);
    }
  }
});

test("gate: for an approved request, an invalid credential gets 401 and a credential for ANOTHER report gets 403 - neither reaches the database", async () => {
  for (const bad of ["garbage", "a.b", issueSigningCredential(claims, T0).token /* expired long ago */]) {
    const r = await run({ authorization: `${SIGNING_SCHEME}${bad}` }, "GET", "/sr1/signing-view");
    assert.equal(r.status, 401);
    assert.equal(r.body.code, "SIGNING_SESSION_INVALID");
    assert.equal(r.nexted, false);
  }
  const other = issueSigningCredential({ ...claims, reportId: "sr2" }).token;
  const r = await run({ authorization: `${SIGNING_SCHEME}${other}` }, "POST", "/sr1/sign");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "SIGNING_CREDENTIAL_SCOPE");
  const encoded = await run({ authorization: `${SIGNING_SCHEME}${other}` }, "POST", "/sr2%2F..%2Fsr1/sign");
  assert.equal(encoded.status === 403 || encoded.status === 401, true);
});

test("wiring: the gate is the FIRST thing in the service-report router, and a request it did not take still needs a normal Bearer login; no other router knows the scheme", () => {
  const root = resolve(__dirname, "..");
  const routes = readFileSync(resolve(root, "src/routes/serviceReports.ts"), "utf8").replace(/\r\n/g, "\n");
  const useGate = routes.indexOf("serviceReportsRouter.use(signingCredentialGate);");
  const useAuth = routes.indexOf("(req as SigningRequest).signing ? next() : authenticate(req, res, next)");
  const firstRoute = routes.indexOf("serviceReportsRouter.get(");
  assert.ok(useGate > 0 && useAuth > useGate && firstRoute > useAuth, "gate, then the login rule, then every route");
  assert.equal((routes.match(/serviceReportsRouter\.use\(/g) ?? []).length, 2);
  // the only place the scheme is read is the gate
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]));
  const readers = walk(resolve(root, "src")).filter((f) => f.endsWith(".ts") && /["`']Signing |SIGNING_SCHEME|signingCredentialGate/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers.map((f) => f.replace(/\\/g, "/").split("/src/")[1]).sort(), ["middleware/signingCredential.ts", "routes/serviceReports.ts"]);
  // Bearer-only login is untouched
  const auth = readFileSync(resolve(root, "src/middleware/auth.ts"), "utf8");
  assert.match(auth, /header\?\.startsWith\("Bearer "\)/);
  assert.doesNotMatch(auth, /Signing/);
  // the three approved handlers insist on a credential (except sign, which also serves the staff flow)
  assert.match(routes, /serviceReportsRouter\.get\("\/:id\/signing-view"[\s\S]{0,200}if \(!req\.signing\) return res\.status\(403\)/);
  assert.match(routes, /serviceReportsRouter\.post\("\/:id\/signing-session\/cancel"[\s\S]{0,200}if \(!req\.signing\) return res\.status\(403\)/);
  // the records that decide whether a credential is live are written strictly (not swallowed)
  assert.match(routes, /async function signingSessionEvent[\s\S]{0,600}await prisma\.serviceReportEvent\.create/);
  assert.doesNotMatch(routes.slice(routes.indexOf("async function signingSessionEvent"), routes.indexOf("const staleVersion")), /catch/);
});
