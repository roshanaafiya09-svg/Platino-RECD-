// The in-person signing session (lib/signingSession.ts): bound to one report, one version and one staff login, short-lived, forgery-proof, and never
// interchangeable with a login token. Pure functions - no database, no network.
process.env.JWT_SECRET = "test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import { SERVICE_REPORT_LIMITS } from "@recd/shared";
import { SIGNING_SESSION_TTL_MS, checkSigningSession, issueSigningSession } from "../src/lib/signingSession";

const claims = { reportId: "sr1", version: 3, staffId: "staff1" };
const T0 = 1_800_000_000_000;

test("the session lasts exactly SIGNING_SESSION_MINUTES", () => {
  assert.equal(SIGNING_SESSION_TTL_MS, SERVICE_REPORT_LIMITS.SIGNING_SESSION_MINUTES * 60_000);
  const { expiresAt } = issueSigningSession(claims, T0);
  assert.equal(expiresAt.getTime(), T0 + SIGNING_SESSION_TTL_MS);
});

test("a session is accepted for exactly the report, version and staff login it was issued for, until it expires", () => {
  const { token } = issueSigningSession(claims, T0);
  assert.deepEqual(checkSigningSession(token, claims, T0 + 1000), { ok: true });
  assert.deepEqual(checkSigningSession(token, claims, T0 + SIGNING_SESSION_TTL_MS), { ok: true }, "valid up to the last moment");
  assert.deepEqual(checkSigningSession(token, claims, T0 + SIGNING_SESSION_TTL_MS + 1), { ok: false, reason: "expired" });
  assert.deepEqual(checkSigningSession(token, { ...claims, reportId: "sr2" }, T0), { ok: false, reason: "other_report" });
  assert.deepEqual(checkSigningSession(token, { ...claims, version: 4 }, T0), { ok: false, reason: "other_version" });
  assert.deepEqual(checkSigningSession(token, { ...claims, staffId: "staff2" }, T0), { ok: false, reason: "other_user" });
});

test("forged, edited and malformed sessions are refused", () => {
  const { token } = issueSigningSession(claims, T0);
  const [payload, mac] = token.split(".");
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), v: 99, e: T0 + 1e12 })).toString("base64url");
  assert.equal(checkSigningSession(`${edited}.${mac}`, { ...claims, version: 99 }, T0).ok, false, "an edited payload does not match its signature");
  assert.equal(checkSigningSession(`${payload}.${mac.slice(0, -2)}AA`, claims, T0).ok, false, "a wrong signature");
  for (const bad of ["", "abc", "a.b.c", ".", "x.", ".x", "not a token at all"]) assert.equal(checkSigningSession(bad, claims, T0).ok, false, JSON.stringify(bad));
  assert.equal(checkSigningSession(undefined as unknown as string, claims, T0).ok, false);
});

test("a session is not a login token, and a login token is not a session", async () => {
  const { signToken, verifyToken } = await import("../src/lib/jwt"); // imported here: jwt.ts reads JWT_SECRET when it is first loaded
  const { token } = issueSigningSession(claims, T0);
  assert.throws(() => verifyToken(token), "a signing session can never be presented as a Bearer token");
  const login = signToken({ userId: "staff1", roleKey: "management" });
  assert.equal(checkSigningSession(login, claims, Date.now()).ok, false, "a login token is not a signing session");
});

test("sessions issued at different times differ, and one cannot be turned into another", () => {
  const a = issueSigningSession(claims, T0).token;
  const b = issueSigningSession(claims, T0 + 5000).token;
  assert.notEqual(a, b);
  assert.equal(checkSigningSession(a, claims, T0 + SIGNING_SESSION_TTL_MS + 1).ok, false);
  assert.equal(checkSigningSession(b, claims, T0 + SIGNING_SESSION_TTL_MS + 1).ok, true, "the later session lives later");
});
