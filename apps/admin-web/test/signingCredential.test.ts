// The customer step of the in-person signing runs on a SIGNING CREDENTIAL, not on the staff login (lib/signingCredential.ts and the pages that use it).
// The repo has no component-test runner, so the storage rules are tested as functions against a stand-in for the browser's storage, and the wiring is
// checked in the source. How it behaves in a real browser is covered by the manual phone-sized run (see the Stage 4 report).
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STAFF_RELEASED_EVENT, clearSigningCredential, hasCredentialForPath, isAllowedReturnPath, readSigningCredential, releaseStaffLogin, saveSigningCredential,
  setAfterLoginPath, signingReportIdFromPath, takeAfterLoginPath,
} from "../src/lib/signingCredential";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), _m: m };
}
let session: ReturnType<typeof memoryStorage>;
let local: ReturnType<typeof memoryStorage>;
let events: string[];
const g = globalThis as any;

beforeEach(() => {
  session = memoryStorage();
  local = memoryStorage();
  events = [];
  g.window = { sessionStorage: session, localStorage: local, dispatchEvent: (e: { type: string }) => void events.push(e.type) };
  g.Event = class { constructor(public type: string) {} };
});
afterEach(() => {
  delete g.window;
});

const NOW = 1_800_000_000_000;
const cred = (over: Record<string, unknown> = {}) => ({ reportId: "r1", token: "tok.en", expiresAt: new Date(NOW + 10 * 60_000).toISOString(), version: 3, ...over });

test("the credential is kept for this tab (sessionStorage) and read back only for the report it was issued for, until it runs out", () => {
  saveSigningCredential(cred());
  assert.ok(session.getItem("recd_signing_credential"), "kept in sessionStorage");
  assert.equal(local.getItem("recd_signing_credential"), null, "never in localStorage");
  assert.deepEqual(readSigningCredential("r1", NOW), cred());
  assert.equal(readSigningCredential("r2", NOW), null, "another report: nothing (and it is removed)");
  assert.equal(session.getItem("recd_signing_credential"), null);
  saveSigningCredential(cred());
  assert.ok(readSigningCredential("r1", NOW + 9 * 60_000));
  assert.equal(readSigningCredential("r1", NOW + 10 * 60_000 + 1), null, "expired: nothing, and it is removed");
  assert.equal(session.getItem("recd_signing_credential"), null);
});

test("damaged or foreign stored data is ignored and removed, never trusted", () => {
  for (const raw of ["not json", "{}", JSON.stringify({ reportId: "r1" }), JSON.stringify({ reportId: "r1", token: 5, expiresAt: "x", version: 1 }), JSON.stringify({ ...cred(), expiresAt: "garbage" })]) {
    session.setItem("recd_signing_credential", raw);
    assert.equal(readSigningCredential("r1", NOW), null, raw.slice(0, 20));
    assert.equal(session.getItem("recd_signing_credential"), null);
  }
});

test("clearing removes it; a browser that refuses storage just means no resume after a reload (nothing throws)", () => {
  saveSigningCredential(cred());
  clearSigningCredential();
  assert.equal(readSigningCredential("r1", NOW), null);
  g.window = { get sessionStorage(): never { throw new Error("denied"); }, localStorage: local, dispatchEvent: () => {} };
  assert.doesNotThrow(() => saveSigningCredential(cred()));
  assert.doesNotThrow(() => clearSigningCredential());
  assert.equal(readSigningCredential("r1", NOW), null);
});

test("the signing address and 'does this tab hold a credential for it' rules", () => {
  assert.equal(signingReportIdFromPath("/service-reports/abc123/sign"), "abc123");
  assert.equal(signingReportIdFromPath("/service-reports/abc123/sign/"), "abc123");
  for (const p of ["/service-reports/abc123", "/service-reports/abc123/sign/x", "/service-reports", "/login", "/x/service-reports/abc/sign"]) assert.equal(signingReportIdFromPath(p), null, p);
  saveSigningCredential(cred({ reportId: "abc123", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal(hasCredentialForPath("/service-reports/abc123/sign"), true);
  assert.equal(hasCredentialForPath("/service-reports/other/sign"), false, "a credential for one report opens no other signing screen");
  assert.equal(hasCredentialForPath("/service-reports/abc123"), false, "and not the report page");
  assert.equal(hasCredentialForPath("/dashboard"), false, "and no other page");
});

test("releasing the staff login: the token and customer data are removed from storage, the sign-in is not put anywhere, the app is told - and the credential is NOT touched", () => {
  local.setItem("recd_token", "STAFF-LOGIN");
  local.setItem("recd_customer_ord", "X");
  saveSigningCredential(cred());
  releaseStaffLogin();
  assert.equal(local.getItem("recd_token"), null);
  assert.equal(local.getItem("recd_customer_ord"), null);
  assert.deepEqual(events, [STAFF_RELEASED_EVENT]);
  assert.ok(readSigningCredential("r1", NOW), "the customer step keeps its credential");
  // the staff token is in no storage at all now
  for (const st of [session, local]) for (const [, v] of st._m) assert.ok(!v.includes("STAFF-LOGIN"));
});

test("after signing in again, staff return only to a report page (never to an arbitrary address), once", () => {
  assert.equal(isAllowedReturnPath("/service-reports/abc_123-X"), true);
  for (const p of ["/service-reports/abc/sign", "https://evil.example/service-reports/abc", "//evil.example", "/users", "/service-reports/", "/service-reports/a/b", "javascript:alert(1)", ""]) assert.equal(isAllowedReturnPath(p), false, p);
  setAfterLoginPath("/service-reports/abc");
  assert.equal(takeAfterLoginPath(), "/service-reports/abc");
  assert.equal(takeAfterLoginPath(), null, "used once");
  setAfterLoginPath("//evil.example");
  assert.equal(takeAfterLoginPath(), null);
  session.setItem("recd_after_login", "//evil.example"); // even if something wrote a bad value, it is not used
  assert.equal(takeAfterLoginPath(), null);
});

// ---- wiring -----------------------------------------------------------------------------------------------------------------------------------

const page = read("apps/admin-web/src/app/service-reports/[id]/sign/page.tsx");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const context = read("apps/admin-web/src/components/AuthContext.tsx");
const client = read("apps/admin-web/src/lib/apiClient.ts");

test("the credential request never carries the staff login and never bounces the page to sign-in", () => {
  const fn = client.slice(client.indexOf("export async function apiWithSigningCredential"), client.indexOf("export async function apiBlob"));
  assert.match(fn, /Authorization: `Signing \$\{credential\}`/);
  assert.doesNotMatch(fn, /Bearer|getToken|clearToken|window\.location/);
  assert.match(fn, /\.\.\.options\.headers, Authorization:/, "the Authorization header cannot be overridden by a caller");
});

test("signing screen: hand-over asks for the credential, keeps it, takes the staff login off the device, then the customer step runs on the credential only", () => {
  const start = page.slice(page.indexOf("async function startSigning"), page.indexOf("async function signNow"));
  assert.match(start, /signingCredential\?: string; expiresAt\?: string; version\?: number/);
  assert.ok(start.indexOf("saveSigningCredential(c)") < start.indexOf("releaseStaffLogin()") && start.indexOf("releaseStaffLogin()") < start.indexOf("await loadCustomerView(c)"));
  // the customer step's three requests are credential requests
  assert.match(page, /apiWithSigningCredential<SigningView>\(`\/service-reports\/\$\{c\.reportId\}\/signing-view`, c\.token\)/);
  assert.match(page, /apiWithSigningCredential<[^>]*>\(`\/service-reports\/\$\{id\}\/sign`, credential\.token/);
  assert.match(page, /apiWithSigningCredential\(`\/service-reports\/\$\{id\}\/signing-session\/cancel`, credential\.token/);
  // inside the credential branch of signNow there is no staff request
  const credSign = page.slice(page.indexOf("if (credential) {\n      // Customer step"), page.indexOf("    try {\n      await api(`/service-reports/${id}/sign`"));
  assert.doesNotMatch(credSign, /\bapi\(/);
  // the page never reads the staff user or token
  assert.doesNotMatch(page, /useAuth|getToken|recd_token|localStorage/);
});

test("signing screen: the same validation as before - nothing was loosened (name, signature, approval, version)", () => {
  assert.match(page, /const canSignNow = !!signatureImage && signerName\.trim\(\)\.length >= SERVICE_REPORT_LIMITS\.SIGNER_NAME_MIN && confirm && busy === null;/);
  assert.match(page, /body: JSON\.stringify\(\{ signerName, signatureImage, version: report\.version, confirm: true, signingSession: credential\.token \}\)/);
  assert.match(page, /useState\(""\)/);
});

test("reload: the page resumes the customer step from the credential this tab kept; otherwise it is a normal staff visit", () => {
  assert.match(page, /const stored = readSigningCredential\(id\);\s*if \(stored\) void loadCustomerView\(stored\);\s*else void load\(\);/);
  assert.match(guard, /if \(isInPersonSigningPath\(pathname\) && hasCredentialForPath\(pathname\)\) return;/, "no redirect to sign-in while this tab holds the credential for THIS report");
  assert.match(guard, /if \(isInPersonSigningPath\(pathname\) && hasCredentialForPath\(pathname\)\) return <div className="min-h-screen bg-gray-50">\{children\}<\/div>;/);
  // and ONLY for that one screen: every other page with no staff user still goes to sign-in
  assert.match(guard, /if \(pathname !== "\/login"\) router\.push\("\/login"\);/);
});

test("cancel, completion, expiry and a refused credential all end the customer step and require staff to sign in again", () => {
  assert.match(page, /async function cancelSigning\(\)[\s\S]{0,600}signing-session\/cancel[\s\S]{0,400}endCustomerStep\("Signing was cancelled\. Nothing was saved\."\)/);
  assert.match(page, /onClick=\{cancelSigning\} data-testid="cancel-signing"/);
  // completion clears the credential and shows the hand-back screen with no PDF buttons (there is no staff login to fetch it with)
  assert.match(page, /clearSigningCredential\(\);\s*setCredential\(null\);\s*setSignatureImage\(null\);\s*setReport\(\{ \.\.\.report, status: SERVICE_REPORT_STATUS\.SIGNED/);
  const doneCred = page.slice(page.indexOf("stage === \"done\" && viaCredential"), page.indexOf("// ---- Step 3: addressed to the member of staff again"));
  assert.match(doneCred, /staffSignIn/);
  assert.doesNotMatch(doneCred, /download\(|SharePdfButton|Download signed PDF/);
  // expiry: a timer ends the step at the credential's time; the server enforces it regardless
  assert.match(page, /setTimeout\(\(\) => endCustomerStep\(SESSION_ENDED\), Math\.max\(0, Date\.parse\(credential\.expiresAt\) - Date\.now\(\)\)\)/);
  // a refusal from the server ends the step (401, or one of the "this session is over" codes) but a validation error lets the customer correct and retry
  assert.match(page, /ENDING_CODES = \["SIGNING_SESSION_INVALID", "STALE_VERSION", "ALREADY_SIGNED", "REPORT_NOT_SIGNABLE", "BAD_TRANSITION"\]/);
  assert.match(page, /err\.status === 401\) \|\| \(code && ENDING_CODES\.includes\(code\)\)\) endCustomerStep\(text\);\s*else setError\(text\)/);
  // the ended screen and the done screen both offer the staff sign-in, which returns to the report afterwards
  assert.match(page, /href="\/login"\s*onClick=\{\(\) => setAfterLoginPath\(`\/service-reports\/\$\{id\}`\)\}/);
  assert.match(page, /data-testid="signing-ended"/);
});

test("staff signing in again: a fresh staff login ends any customer credential in the tab and returns to the report; the guard only follows a report path", () => {
  assert.match(context, /clearSigningCredential\(\); \/\/ signing in again as staff ends any customer signing session in this tab\s*setToken\(token\);/);
  assert.match(context, /addEventListener\(STAFF_RELEASED_EVENT, onReleased\)/);
  assert.match(guard, /const back = pathname === "\/login" \? takeAfterLoginPath\(\) : null;/);
});

test("old path kept for the rollout: with no credential from the server, the page still uses the staff login and the signing session", () => {
  assert.match(page, /signingSession: session \}\),\s*\}\); \/\/ \(staff-login path, kept for an API without signing credentials\)/);
  assert.match(page, /setSession\(r\.signingSession\);\s*setStage\("customer"\);/);
});
