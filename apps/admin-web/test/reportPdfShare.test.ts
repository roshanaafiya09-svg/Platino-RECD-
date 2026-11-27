// Stage 3 of the mobile work: opening, downloading and SHARING a report PDF on a phone.
// No browser is needed: the share logic takes the browser's `navigator` as a parameter, so it is tested with stand-ins. Real share sheets (iOS Safari,
// Android Chrome) can only be checked on a real phone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canSharePdfFiles, sharePdfFile, reportPdfName, withPdfFallbackHint, endSentence } from "../src/lib/reportFiles";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "service-report-R1.pdf", { type: "application/pdf" });
const domError = (name: string) => Object.assign(new Error(name), { name });

test("canSharePdfFiles: only when the browser can share files (share + canShare + canShare says yes for a PDF)", () => {
  assert.equal(canSharePdfFiles(undefined), false);
  assert.equal(canSharePdfFiles({}), false, "a desktop browser without sharing");
  assert.equal(canSharePdfFiles({ share: async () => {} }), false, "share() without canShare() cannot share files");
  assert.equal(canSharePdfFiles({ share: async () => {}, canShare: () => false }), false, "share exists but not for files");
  assert.equal(canSharePdfFiles({ share: async () => {}, canShare: () => { throw new Error("x"); } }), false);
  assert.equal(canSharePdfFiles({ share: async () => {}, canShare: (d) => (d.files ?? []).every((f) => f.type === "application/pdf") }), true);
});

test("sharePdfFile: hands the FILE (not a link) to the share sheet", async () => {
  const calls: Array<{ files?: File[]; title?: string; text?: string; url?: unknown }> = [];
  const nav = { share: async (d: { files?: File[]; title?: string }) => void calls.push(d), canShare: () => true };
  const file = pdf();
  assert.equal(await sharePdfFile(file, "Service report R1", nav), "shared");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].files, [file]);
  assert.equal(calls[0].title, "Service report R1");
  assert.equal("url" in calls[0], false, "no URL is shared, so there is nothing to open without logging in");
});

test("sharePdfFile: closing the sheet is not an error; an expired tap asks for a tap; unsupported browsers fall back", async () => {
  const mk = (err: Error | null, can = true) => ({ canShare: () => can, share: async () => { if (err) throw err; } });
  assert.equal(await sharePdfFile(pdf(), "t", mk(domError("AbortError"))), "cancelled");
  assert.equal(await sharePdfFile(pdf(), "t", mk(domError("NotAllowedError"))), "needs-tap");
  assert.equal(await sharePdfFile(pdf(), "t", mk(domError("NotSupportedError"))), "unsupported");
  assert.equal(await sharePdfFile(pdf(), "t", mk(null, false)), "unsupported");
  assert.equal(await sharePdfFile(pdf(), "t", {}), "unsupported");
  await assert.rejects(() => sharePdfFile(pdf(), "t", mk(domError("DataError"))), /DataError/, "anything else is reported, not hidden");
});

test("file name and failure hint: the hint is added on phones only (no window here, so none)", () => {
  assert.equal(reportPdfName("TCK-1-R1"), "service-report-TCK-1-R1.pdf");
  assert.equal(withPdfFallbackHint("It failed."), "It failed.", "laptops and desktops get the message exactly as before");
  assert.equal(endSentence("Invalid or expired token"), "Invalid or expired token.");
  assert.equal(endSentence("Already ends well. "), "Already ends well.");
});

test("access: the PDF is always fetched with the signed-in user's login token from the existing protected route - no links, no new server code", () => {
  const files = read("apps/admin-web/src/lib/reportFiles.ts");
  assert.equal((files.match(/apiBlob\(/g) ?? []).length, 3, "download, open and share-fetch all go through apiBlob (Authorization header)");
  assert.match(files, /apiBlob\(`\/service-reports\/\$\{reportId\}\/pdf`\)/);
  assert.doesNotMatch(files, /createShareLink|signedUrl|share-link|publicUrl/i);
  assert.doesNotMatch(files, /navigator\.share\(\{[^}]*url/);
  const apiClient = read("apps/admin-web/src/lib/apiClient.ts");
  assert.match(apiClient, /Authorization: `Bearer \$\{token\}`/);
  // the server route is untouched by this stage and still authorises per request
  const route = read("apps/api/src/routes/serviceReports.ts");
  assert.match(route, /async function sendStoredFile[\s\S]{0,200}loadWithAccess\(req, res/);
});

test("share button: phones only, shown only when the browser can share files, fresh download every time, failures explained", () => {
  const b = read("apps/admin-web/src/components/SharePdfButton.tsx");
  assert.match(b, /md:hidden/);
  assert.match(b, /useEffect\(\(\) => setSupported\(canSharePdfFiles\(\)\), \[\]\)/);
  assert.match(b, /if \(!supported\) return null;/);
  assert.match(b, /ready\.current \?\? \(await fetchReportPdfFile\(reportId, reportNumber\)\)/);
  assert.match(b, /Tap Share PDF again/);
  assert.match(b, /Use Download signed PDF instead/);
  assert.match(b, /shareFailureText\(err, apiErrorMessage\(err, "The report could not be prepared for sharing\."\)\)/);
  assert.match(read("apps/admin-web/src/lib/reportFiles.ts"), /Check your connection and try again, or use Download/);
  assert.match(b, /role=\{notice\.kind === "error" \? "alert" : "status"\}/);
  // the kept PDF is dropped when the report changes (and the component's memory goes with the page)
  assert.match(b, /ready\.current = null;\s*setNotice\(null\)/);
});

test("screens: the share button is on the report page (both PDF blocks), the post-signing screen and the phone cards; the old buttons are all still there", () => {
  const detail = read("apps/admin-web/src/app/service-reports/[id]/page.tsx");
  assert.equal((detail.match(/<SharePdfButton /g) ?? []).length, 2);
  assert.equal((detail.match(/Open in a new tab/g) ?? []).length, 2);
  assert.match(detail, /Download PDF/);
  assert.match(detail, /Download signed PDF/);
  assert.match(detail, /openReportPdf\(report!\.id, report!\.reportNumber\)/);
  const sign = read("apps/admin-web/src/app/service-reports/[id]/sign/page.tsx");
  assert.equal((sign.match(/<SharePdfButton /g) ?? []).length, 1);
  assert.match(sign, /Download signed PDF/);
  assert.match(sign, /withPdfFallbackHint\(apiErrorMessage\(err, "The signed report could not be downloaded\."\)\)/);
  const list = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");
  assert.equal((list.match(/<SharePdfButton /g) ?? []).length, 1);
  const cardsAt = list.indexOf("reports-mobile-cards");
  assert.ok(list.indexOf("<SharePdfButton ") > cardsAt, "only in the phone cards, not the desktop table");
  assert.match(list, /onClick=\{\(\) => download\(r\)\} className="mr-3 text-xs font-medium/, "the desktop table's PDF link is unchanged");
});

test("opening on a phone: if the new tab is blocked, stay on the report and download instead (laptops keep the old behaviour)", () => {
  const files = read("apps/admin-web/src/lib/reportFiles.ts");
  assert.match(files, /if \(!tab && isPhoneScreen\(\) && reportNumber\) \{\s*await downloadReportPdf\(reportId, reportNumber\);\s*return;\s*\}/);
  assert.match(files, /else window\.location\.href = url;/, "the old fallback is still there for desktops");
});
