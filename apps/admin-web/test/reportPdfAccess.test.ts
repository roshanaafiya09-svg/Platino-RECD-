// Access protection for report PDFs on the phone: a signed-in user WITHOUT access to a report cannot fetch or share its PDF.
// The decision is the server's (GET /service-reports/:id/pdf, covered by the API's database tests and checked live against a local copy); here the
// browser side is tested against a stand-in server that answers like the real one: 200 with the PDF for allowed users, 401 / 403 / 404 otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchReportPdfFile, shareFailureText, sharePdfFile } from "../src/lib/reportFiles";
import { ApiRequestError } from "../src/lib/apiClient";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

type G = { window?: unknown; fetch?: unknown };
const g = globalThis as unknown as G;
const realFetch = g.fetch;

/** A stand-in for the API: the allowed token gets the PDF, a token with no access gets 403, a stranger's report 404, no/expired token 401. */
function fakeServer(rules: { allowed: string; mode?: "forbidden" | "notfound" }) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  g.fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization ?? null;
    seen.push({ url, auth });
    if (!auth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    if (auth !== `Bearer ${rules.allowed}`) {
      return rules.mode === "notfound"
        ? new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
        : new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    }
    return new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200, headers: { "content-type": "application/pdf" } });
  };
  return seen;
}
function signedInAs(token: string | null) {
  g.window = { localStorage: { getItem: () => token } };
}
test.afterEach(() => {
  g.fetch = realFetch;
  delete g.window;
});

/** The share flow exactly as the button runs it: fetch with the user's login first, and only a fetched file reaches the share sheet. */
async function shareLikeTheButton(reportId: string) {
  let shareCalls = 0;
  const nav = { canShare: () => true, share: async () => void shareCalls++ };
  try {
    const file = await fetchReportPdfFile(reportId, "R1");
    return { outcome: await sharePdfFile(file, "Service report R1", nav), shareCalls, error: null as unknown };
  } catch (error) {
    return { outcome: "failed" as const, shareCalls, error };
  }
}

test("a user with access: the PDF is fetched with their own token and handed to the share sheet", async () => {
  const seen = fakeServer({ allowed: "ENGINEER" });
  signedInAs("ENGINEER");
  const r = await shareLikeTheButton("abc");
  assert.equal(r.outcome, "shared");
  assert.equal(r.shareCalls, 1);
  assert.match(seen[0].url, /\/service-reports\/abc\/pdf$/, "the existing protected route, no new endpoint");
  assert.equal(seen[0].auth, "Bearer ENGINEER");
});

test("a signed-in user WITHOUT access to the report: the request fails (403) and nothing is shared", async () => {
  fakeServer({ allowed: "ENGINEER" });
  signedInAs("SOMEONE_ELSE");
  const r = await shareLikeTheButton("abc");
  assert.equal(r.outcome, "failed");
  assert.equal(r.shareCalls, 0, "the share sheet is never opened");
  assert.ok(r.error instanceof ApiRequestError && r.error.status === 403);
  assert.equal(shareFailureText(r.error, "Forbidden"), "You do not have access to this report's PDF. Nothing was shared.");
});

test("a report the user cannot see at all (404) and a missing / expired login (401) also fail with nothing shared", async () => {
  fakeServer({ allowed: "ENGINEER", mode: "notfound" });
  signedInAs("A_CUSTOMER_OF_ANOTHER_COMPANY");
  const nf = await shareLikeTheButton("abc");
  assert.equal(nf.shareCalls, 0);
  assert.ok(nf.error instanceof ApiRequestError && nf.error.status === 404);
  assert.match(shareFailureText(nf.error, "Not found"), /do not have access/);

  signedInAs(null);
  const none = await shareLikeTheButton("abc");
  assert.equal(none.shareCalls, 0);
  assert.ok(none.error instanceof ApiRequestError && none.error.status === 401);
  assert.match(shareFailureText(none.error, "Unauthorized"), /session has expired/);
});

test("other failures (network, storage) keep the retry / Download pointer; access refusals never say 'check your connection'", () => {
  assert.match(shareFailureText(new ApiRequestError("x", 502, {}), "The signed report could not be read right now"), /^The signed report could not be read right now\. Check your connection and try again, or use Download\.$/);
  assert.match(shareFailureText(new TypeError("Failed to fetch"), "Failed to fetch"), /Check your connection/);
  for (const s of [401, 403, 404]) assert.doesNotMatch(shareFailureText(new ApiRequestError("x", s, {}), "x"), /connection/);
});

test("the server's authorisation is untouched: every PDF request still goes through loadWithAccess, and unknown users get no file", () => {
  const route = read("apps/api/src/routes/serviceReports.ts");
  assert.match(route, /async function sendStoredFile[\s\S]{0,200}loadWithAccess\(req, res/);
  assert.match(route, /if \(!staff\.read && !customer\) \{/);
  const button = read("apps/admin-web/src/components/SharePdfButton.tsx");
  assert.match(button, /shareFailureText\(err, /);
  assert.ok(button.indexOf("fetchReportPdfFile(") < button.indexOf("sharePdfFile("), "the file is fetched (and authorised by the server) before the share sheet is touched");
});

test("phone cards on the all-reports list: PDF, Share and Open are all at least 44px tall, in one row, with the desktop table untouched", () => {
  const list = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");
  const cards = list.slice(list.indexOf("reports-mobile-cards"));
  assert.match(cards, /<button onClick=\{\(\) => download\(r\)\} className="[^"]*min-h-\[44px\][^"]*"/);
  assert.match(cards, /<SharePdfButton [^>]*className="[^"]*min-h-\[44px\][^"]*"/);
  assert.match(cards, /<Link href=\{`\/service-reports\/\$\{r\.id\}`\} className="flex min-h-\[44px\] flex-1 items-center justify-center/);
  assert.match(cards, /<div className="mt-3 flex gap-2">/, "still one row of three buttons");
  const table = list.slice(0, list.indexOf("reports-mobile-cards"));
  assert.doesNotMatch(table, /min-h-\[44px\]/, "the laptop / desktop table is unchanged");
});
