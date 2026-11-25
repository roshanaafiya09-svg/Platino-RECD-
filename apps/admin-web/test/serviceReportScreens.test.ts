// Service-report screens. The repo has no component-test runner, so these are source-level checks of the wiring
// (reading the files as text) plus the shared rules the screens rely on. They do NOT replace trying the screens in a
// real browser (mouse and touch signing, PDF download) - that has not been done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const pad = read("apps/admin-web/src/components/SignaturePad.tsx");
const detail = read("apps/admin-web/src/app/service-reports/[id]/page.tsx");
const list = read("apps/admin-web/src/app/service-reports/page.tsx");
const complaints = read("apps/admin-web/src/app/complaints/page.tsx");
const portal = read("apps/admin-web/src/app/customer/portal/page.tsx");
const unitPage = read("apps/admin-web/src/app/recd-units/[id]/page.tsx");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const files = read("apps/admin-web/src/lib/reportFiles.ts");

test("signature pad: drawn with mouse, finger or stylus (Pointer Events), no page scroll while signing, clearable", () => {
  assert.match(pad, /onPointerDown/);
  assert.match(pad, /onPointerMove/);
  assert.match(pad, /onPointerUp/);
  assert.match(pad, /setPointerCapture/);
  assert.match(pad, /touchAction: "none"/);
  assert.match(pad, /toDataURL\("image\/png"\)/);
  assert.match(pad, /clearRect/);
  assert.match(pad, /onChange\(null\)/, "clearing reports 'no signature' to the form");
  assert.match(pad, /disabled/);
});

test("signing screen: the customer reviews the report, types a name, draws, confirms - and cannot sign until all are done", () => {
  assert.match(detail, /Review and sign/);
  assert.match(detail, /<SignaturePad/);
  assert.match(detail, /const canFinishSigning = !!signatureImage && signerName\.trim\(\)\.length >= SERVICE_REPORT_LIMITS\.SIGNER_NAME_MIN && confirm/);
  assert.match(detail, /disabled=\{!canFinishSigning\}/);
  assert.match(detail, /I have reviewed this report and approve it/);
  assert.match(detail, /p\.canSign/, "the section only shows when the server says this user may sign");
  assert.match(detail, /version: report!\.version/, "the signature is bound to the version that was reviewed");
  assert.match(detail, /confirm: true/);
});

test("signing screen: success and failure are both shown, and a stale or already-signed answer reloads the report", () => {
  assert.match(detail, /the report is signed and final/);
  assert.match(detail, /kind: "error"/);
  assert.match(detail, /STALE_VERSION/);
  assert.match(detail, /ALREADY_SIGNED/);
  const run = detail.slice(detail.indexOf("async function run"), detail.indexOf("const payload"));
  assert.ok(run.indexOf("okText") < run.indexOf("catch"), "the success text is only set after the work succeeded");
});

test("staff workflow: edit a draft, save, submit for signature, take back; all driven by the server's permission flags", () => {
  for (const flag of ["canEdit", "canSubmit", "canReopen", "canSign"]) assert.match(detail, new RegExp(`p\.${flag}|permissions\.${flag}|${flag}:`), flag);
  assert.match(detail, /Save draft/);
  assert.match(detail, /Submit for customer signature/);
  assert.match(detail, /Take back to draft to edit/);
  assert.match(detail, /expectedVersion/);
  assert.match(detail, /serviceReportMissingFields\(form\)/, "incomplete reports are caught before the request too");
});

test("signed state: signature, signer, time, download and open - the files are fetched with the login token", () => {
  assert.match(detail, /Signed and final/);
  assert.match(detail, /Download signed PDF/);
  assert.match(detail, /apiBlob\(`\/service-reports\/\$\{report\.id\}\/signature`\)/);
  assert.match(files, /apiBlob\(`\/service-reports\/\$\{reportId\}\/pdf`\)/);
  assert.match(files, /a\.download = `service-report-\$\{reportNumber\}\.pdf`/);
  assert.match(detail, /pdfAvailable/);
});

test("loading, empty and error states exist on both screens", () => {
  assert.match(detail, /data-testid="report-loading"/);
  assert.match(detail, /data-testid="report-error"/);
  assert.match(list, /data-testid="reports-loading"/);
  assert.match(list, /data-testid="reports-empty"/);
  assert.match(list, /Suspense/, "useSearchParams needs a Suspense boundary for the production build");
});

test("entry points: ticket list (staff), customer portal, and the RECD unit history", () => {
  assert.match(complaints, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.match(portal, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.match(unitPage, /Download signed PDF/);
  assert.match(unitPage, /serviceReports/);
  assert.match(unitPage, /No service report uploaded/, "the legacy attachment text and download are kept");
  assert.match(unitPage, /download=\{reportFileName\(c\.ticketNumber, c\.serviceReportUrl\)\}/);
});

test("the staff permission rule for /service-reports never reaches a customer (customers sign there); the API decides access", () => {
  // Staff list: a route rule exists (menu + guard), but the customer branch of the guard runs and returns BEFORE the permission check.
  assert.match(guard, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  const customerBranch = guard.indexOf('user.role.key === "customer"');
  const permissionCheck = guard.indexOf("const matched = matchRoute(pathname);");
  assert.ok(customerBranch > 0 && permissionCheck > customerBranch, "customers are handled first");
});

// ---------------------------------------------------------------------------------------------------------
// AMC service reports (Requirement 5) - source-level checks, NOT a substitute for a browser / phone test.
const amcOrders = read("apps/admin-web/src/app/amc-orders/page.tsx");
const reportUi = read("apps/admin-web/src/lib/serviceReportUi.ts");

test("AMC order list: every order links to its service reports", () => {
  assert.match(amcOrders, /\/service-reports\?amcOrderId=\$\{o\.id\}/);
  assert.match(amcOrders, /Service reports/);
});

test("AMC list screen: shows the AMC, offers only units the AMC covers, has NO acknowledgement option, and explains frequency vs reports", () => {
  assert.match(list, /amcOrderId/);
  assert.match(list, /data-testid="amc-context"/);
  assert.match(list, /data-testid="amc-unit-select"/);
  assert.match(list, /u\.status === "active" && u\.serialNo/, "only active units with a serial are offered");
  assert.doesNotMatch(list, /data-testid="ack-required"/, "the 'customer need not sign' checkbox is gone");
  assert.doesNotMatch(list.split(/\r?\n/).filter((l) => !l.includes("acknowledgementRequired: boolean")).join("\n"), /acknowledgementRequired/, "no screen code sends or edits the flag");
  assert.match(list, /signed by the customer/);
  assert.match(list, /schedule/i);
  assert.match(list, /Contracted visits per year/);
  assert.match(list, /\{ amcOrderId, unitId, \.\.\.form \}/, "the client sends only the AMC and the unit - never customer, site or serial");
  const bodyLine = list.split(/\r?\n/).find((l) => l.includes("const body = amcOrderId")) ?? "";
  assert.doesNotMatch(bodyLine, /customerId|siteId|serial/i);
});

test("AMC detail screen: AMC order, type, serial are shown; there is no way to finalise without the customer; older unsigned reports are labelled", () => {
  assert.match(detail, /AMC order/);
  assert.match(detail, /RECD serial number/);
  assert.doesNotMatch(detail, /ack-required-toggle|Finalise without customer signature|ackRequired/, "the unsigned option is gone");
  assert.match(detail, /Submit for customer signature/);
  assert.match(detail, /Submitted and final - not signed \(older report\)/);
  assert.match(detail, /data-testid="submitted-section"/);
});

test("a submitted (unsigned) report is never styled or worded as signed", () => {
  assert.doesNotMatch(reportUi.slice(reportUi.indexOf("SUBMITTED")), /status-pill-success/);
  const submitted = detail.slice(detail.indexOf('data-testid="submitted-section"'), detail.indexOf("{/* Signed */}"));
  assert.doesNotMatch(submitted, /Signed and final|Signed by/i);
  assert.match(submitted, /not signed/i);
  assert.match(detail, /report\.status === SERVICE_REPORT_STATUS\.SIGNED && \(/, "the signed block is only for status signed");
});

test("customer entry point: the portal lists their reports and the sign step stays behind the server's canSign flag", () => {
  assert.match(portal, /\/service-reports\/mine/);
  assert.match(portal, /data-testid="my-service-reports"/);
  assert.match(portal, /Review & sign/);
  assert.match(detail, /p\.canSign/);
});

test("RECD unit page shows its AMC reports only inside the AMC section (which is hidden from roles without AMC access)", () => {
  assert.match(unitPage, /amcVisible && \(data\.amcServiceReports \?\? \[\]\)\.length > 0/);
  assert.match(unitPage, /data-testid="unit-amc-reports"/);
});

test("page guard: a customer is NOT bounced off the report pages (found in the browser walkthrough), but only those pages", () => {
  const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
  // the helper (now in lib/routeAccess.ts, shared with its tests) and its use in both the redirect effect and the render branch
  assert.match(guard, /from "@\/lib\/routeAccess"/);
  assert.match(guard, /pathname !== "\/customer\/portal" && !isCustomerReportPath\(pathname\)/);
  assert.match(guard, /isCustomerPortal \|\| isCustomerReportPath\(pathname\)/);
  // the exact path rule: the report list (the portal's "Service reports & signing" link) or one report id, nothing broader
  const access = read("apps/admin-web/src/lib/routeAccess.ts");
  assert.match(access, /export function isCustomerReportPath/);
  assert.ok(guard.includes("service-reports"), "the guard names the report route");
});

test("customer, site and DG entry points: Customer and Site pages link to their reports, the unit page links each AMC order, and the list filters by them", () => {
  const customerPage = read("apps/admin-web/src/app/customers/[id]/page.tsx");
  const sitePage = read("apps/admin-web/src/app/sites/[id]/page.tsx");
  assert.match(customerPage, /\/service-reports\?customerId=\$\{customer\.id\}/);
  assert.match(customerPage, /canOpenServiceReports\(hasPermission\)/, "offered only to staff who may open the list; the API still scopes the rows");
  assert.match(sitePage, /\/service-reports\?siteId=\$\{site\.id\}/);
  assert.match(sitePage, /canOpenServiceReports\(hasPermission\)/);
  assert.match(unitPage, /\/service-reports\?amcOrderId=\$\{a\.id\}/, "a way into the AMC order's reports for service staff who cannot open the AMC Order list");
  assert.match(unitPage, /unit-report-|unit-amc-report-/, "the existing report sections on the unit page are kept");
  const all = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");
  assert.match(all, /params\.get\("customerId"\)/);
  assert.match(all, /params\.get\("siteId"\)/);
  assert.match(all, /params\.get\("unitId"\)/);
  assert.match(all, /data-testid="report-scope-filters"/);
  assert.match(all, /start it there|from an existing service ticket/, "the page still explains that a report starts from the ticket or the AMC order");
  assert.doesNotMatch(all, /new-report-form/, "no second create form that bypasses the source record");
});

// ---- Direct service reports (+ New Service Report) ---------------------------------------------------------------------------------------------
const directForm = read("apps/admin-web/src/app/service-reports/DirectReportForm.tsx");
const allReports = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");

test("Service Reports page: a + New Service Report button (only for staff who may create) opens the direct form; the existing search, filters, paging and the ticket / AMC routes stay", () => {
  assert.match(allReports, /\+ New Service Report/);
  assert.match(allReports, /data-testid="new-service-report-button"/);
  assert.match(allReports, /hasPermission\("manage_complaints"\)/, "offered only to the staff who may create; the API enforces it again");
  assert.match(allReports, /!isCustomer && hasPermission/, "never for a customer");
  assert.match(allReports, /<DirectReportForm onClose/);
  for (const kept of [/data-testid="report-filters"/, /Search service reports/, /aria-label="Status"/, /aria-label="Type"/, /report-scope-filters/, /Clear filters/, /data-testid="reports-paging"/, /REPORT_LIST_PAGE_SIZE/]) assert.match(allReports, kept);
  assert.match(allReports, /directly with \+ New Service Report/);
  assert.match(allReports, /existing service ticket/);
  assert.match(allReports, /SERVICE_REPORT_KIND\.DIRECT/, "a Direct type filter");
  assert.match(allReports, /reportKindLabel\(r\.kind\)/, "direct, ticket and AMC rows are labelled");
});

test("direct form: customer first, then that customer's DG; the Site is read-only and comes from the unit; nothing but the unit (and the customer as a cross-check) is sent", () => {
  assert.ok(directForm.includes('"/service-reports/direct-options"'));
  assert.ok(directForm.includes("/service-reports/direct-options?customerId=${encodeURIComponent(id)}"), "units are loaded for the chosen customer only");
  assert.match(directForm, /data-testid="direct-customer-select"/);
  assert.match(directForm, /data-testid="direct-unit-select"/);
  assert.match(directForm, /disabled=\{!customerId\}/, "no unit can be chosen before a customer");
  assert.match(directForm, /setUnitId\(""\)/, "changing the customer clears the unit, so no mismatched pair survives");
  assert.match(directForm, /data-testid="direct-site-card"/);
  assert.match(directForm, /Site \(from the selected unit\)/);
  assert.doesNotMatch(directForm, /<select[^>]*siteId|setSiteId|name="siteId"/, "there is no Site input: it is derived");
  assert.match(directForm, /Not recorded/, "a unit with no serial reads 'Not recorded'");
  const body = directForm.split(/\r?\n/).find((l) => l.includes("JSON.stringify({ customerId, unitId")) ?? "";
  assert.ok(body, "the create call is present");
  assert.doesNotMatch(body, /siteId|serial|status|kind/i);
  assert.match(directForm, /method: "POST"/);
  assert.ok(directForm.includes("router.push(`/service-reports/${created.id}`)"), "the draft opens on the existing report screen, where it is submitted");
});

test("direct form: validation, the open-ticket suggestion and the open-direct-report block", () => {
  assert.match(directForm, /const missing = !customerId \|\| !unitId \|\| !form\.visitDate;/);
  assert.match(directForm, /disabled=\{saving \|\| missing \|\| blocked\}/);
  assert.match(directForm, /max=\{today\(\)\}/, "no future visit date");
  assert.match(directForm, /An open service ticket already exists for this DG\. You may create the Service Report from that ticket instead\./);
  assert.match(directForm, /data-testid="direct-open-ticket-hint"/);
  assert.ok(directForm.includes("/service-reports?complaintId=${unit.openTicket.id}"));
  assert.match(directForm, /data-testid="direct-open-report-block"/);
  assert.match(directForm, /const blocked = !!unit\?\.openDirectReport;/, "only an open DIRECT report blocks; a ticket never does");
  for (const f of ["Work performed", "Findings / observations", "Resolution / outcome", "Parts used", "Remarks", "Service visit date"]) assert.ok(directForm.includes(f), f);
  assert.match(directForm, /SERVICE_REPORT_LIMITS\.TEXT_MAX/, "the same limits as the ticket and AMC forms");
  assert.match(directForm, /apiErrorMessage\(err/, "server refusals (duplicate, mismatch, permission) are shown");
});

test("direct reports on the screens: labelled apart from ticket and AMC reports, detail page, customer portal and RECD unit history", () => {
  assert.match(detail, /"direct"/);
  assert.match(detail, /Direct service report/);
  assert.match(detail, /report\.kind === "direct" \? "← All service reports"/);
  assert.match(detail, /"Not recorded"/);
  assert.match(detail, /Submit for customer signature/);
  assert.match(portal, /r\.kind === "direct" \? "Service visit"/);
  assert.match(portal, /\/service-reports\/mine/);
  assert.match(unitPage, /directServiceReports/);
  assert.match(unitPage, /data-testid="unit-direct-reports"/);
  assert.match(unitPage, /unit-amc-reports-link|unit-amc-report-/, "the AMC and ticket report sections are kept");
  const ui = read("apps/admin-web/src/lib/serviceReportUi.ts");
  assert.match(ui, /reportKindLabel/);
  assert.match(ui, /"Direct"/);
});

test("signing a direct report uses the same screen and the same signature pad as every other report (no second signature system)", () => {
  assert.doesNotMatch(directForm, /SignaturePad|signatureImage/);
  assert.match(detail, /<SignaturePad/);
  assert.match(detail, /p\.canSign/);
  assert.match(detail, /I have reviewed this report and approve it/);
  assert.match(detail, /confirm: true/);
});
