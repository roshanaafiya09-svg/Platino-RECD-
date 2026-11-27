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
const signPage = read("apps/admin-web/src/app/service-reports/[id]/sign/page.tsx");

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

test("in-person signing screen: starts with the hand-over addressed to staff; only then does the customer see the report, type their OWN name, draw, approve - and cannot sign until all are done", () => {
  // step 1: addressed to staff, and it is the default step
  assert.match(signPage, /useState<Stage>\("handoff"\)/);
  assert.match(signPage, /Hand this device to the customer/);
  assert.match(signPage, /Do <strong>not<\/strong> type the customer&apos;s name, draw the signature or approve the report for them/);
  assert.match(signPage, /The customer has the device – start signing/);
  assert.match(signPage, /\/signing-session/);
  assert.match(signPage, /handoffConfirmed: true/);
  // the customer step is only reached after the server has issued the signing credential (or, for an API without credentials, the session)
  assert.ok(signPage.indexOf("await loadCustomerView(c)") > signPage.indexOf("saveSigningCredential(c)"), "the customer step opens only after the credential was issued and kept");
  assert.ok(signPage.indexOf("await loadCustomerView(c)") > signPage.indexOf("releaseStaffLogin()"), "and only after the staff login was taken off the device");
  assert.ok(signPage.lastIndexOf('setStage("customer")') > signPage.indexOf("setSession(r.signingSession)"), "the older path opens the customer step only after its session was issued");
  // step 2: addressed to the customer
  assert.match(signPage, /Please review and sign your service report/);
  assert.match(signPage, /<SignaturePad/);
  assert.match(signPage, /const canSignNow = !!signatureImage && signerName\.trim\(\)\.length >= SERVICE_REPORT_LIMITS\.SIGNER_NAME_MIN && confirm/);
  assert.match(signPage, /disabled=\{!canSignNow\}/);
  assert.match(signPage, /I have reviewed this report and approve it/);
  assert.match(signPage, /Sign and finalise/);
  assert.match(signPage, /version: report\.version/, "the signature is bound to the version that was shown");
  assert.match(signPage, /confirm: true/);
  assert.match(signPage, /signingSession: session/);
  // the name box starts EMPTY and is never filled from the staff login
  assert.match(signPage, /useState\(""\)/);
  assert.doesNotMatch(signPage, /useAuth|user\?\.name|user\.name/, "the signer's name is never taken from the logged-in staff member");
  assert.match(signPage, /Type your own name/);
  // the report is shown read-only before signing
  assert.match(signPage, /data-testid="signing-report-summary"/);
  for (const section of ["Work performed", "Findings / observations", "Resolution / outcome"]) assert.ok(signPage.includes(section), section);
});

test("in-person signing screen: success and failure are both shown; a stale, expired or already-signed answer sends the device back to the hand-over; step 3 is addressed to staff", () => {
  assert.match(signPage, /Report signed and final/);
  assert.match(signPage, /You can take the device back now/);
  assert.match(signPage, /Download signed PDF/);
  assert.match(signPage, /role="alert"/);
  for (const code of ["STALE_VERSION", "SIGNING_SESSION_INVALID", "ALREADY_SIGNED"]) assert.ok(signPage.includes(code), code);
  assert.match(signPage, /function backToHandoff/);
  // the typed name, the drawing and the session belong to one hand-over and are cleared when it ends
  const back = signPage.slice(signPage.indexOf("function backToHandoff"), signPage.indexOf("async function startSigning"));
  for (const cleared of ["setSession(null)", 'setSignerName("")', "setSignatureImage(null)", "setConfirm(false)"]) assert.ok(back.includes(cleared), cleared);
  assert.match(signPage, /Platino staff: cancel this signing/);
  // a draft or someone without access is told so instead of seeing the form
  assert.match(signPage, /data-testid="signing-not-ready"/);
  assert.match(signPage, /data-testid="signing-no-access"/);
  assert.match(signPage, /canCollectSignature/);
});

test("staff workflow: edit a draft, save, submit for signature, then go STRAIGHT to the in-person signing screen; take back; all driven by the server's permission flags", () => {
  for (const flag of ["canEdit", "canSubmit", "canReopen", "canCollectSignature"]) assert.match(detail, new RegExp(`p\\.${flag}|permissions\\.${flag}|${flag}:`), flag);
  assert.match(detail, /Save draft/);
  assert.match(detail, /Submit for customer signature/);
  assert.match(detail, /Take back to draft to edit/);
  assert.match(detail, /expectedVersion/);
  assert.match(detail, /serviceReportMissingFields\(form\)/, "incomplete reports are caught before the request too");
  // after a successful submit the same device opens the signing screen
  assert.match(detail, /const submitted = await run\("submit"/);
  assert.match(detail, /if \(submitted\) router\.push\(`\/service-reports\/\$\{id\}\/sign`\)/);
  // an awaiting report offers a way back into the signing screen, and the old on-page signing form is gone
  assert.match(detail, /Open the customer signing screen/);
  assert.match(detail, /href=\{`\/service-reports\/\$\{report\.id\}\/sign`\}/);
  assert.doesNotMatch(detail, /<SignaturePad|Review and sign|canSign\b|signNow|\/sign`,/, "signing no longer happens on the report page");
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

test("entry points: ticket list (staff) and the RECD unit history - the customer portal no longer links to service reports", () => {
  assert.match(complaints, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.doesNotMatch(portal, /service-reports|Review & sign|Service reports &amp; signing|my-service-reports/, "no customer-portal service-report links, list or signing instructions");
  assert.match(unitPage, /Download signed PDF/);
  assert.match(unitPage, /serviceReports/);
  assert.match(unitPage, /No service report uploaded/, "the legacy attachment text and download are kept");
  assert.match(unitPage, /download=\{reportFileName\(c\.ticketNumber, c\.serviceReportUrl\)\}/);
});

test("the staff permission rule for /service-reports never reaches a customer (customers have no report pages at all); the API decides access", () => {
  assert.match(guard, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  const customerBranch = guard.indexOf('user.role.key === "customer"');
  const permissionCheck = guard.indexOf("const matched = matchRoute(pathname);");
  assert.ok(customerBranch > 0 && permissionCheck > customerBranch, "customers are handled first");
  const branch = guard.slice(customerBranch, permissionCheck);
  assert.doesNotMatch(branch, /service-reports/, "a customer is never sent to, or shown, a service-report page");
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

test("customer portal: no service-report list, no 'Review & sign', no link - and no call to the removed /mine endpoint", () => {
  assert.doesNotMatch(portal, /\/service-reports/);
  assert.doesNotMatch(portal, /Review & sign|my-service-reports|myReports/);
  assert.match(portal, /Submit Complaint/, "the rest of the portal (raising and following complaints) is untouched");
  assert.match(portal, /Support History/);
});

test("RECD unit page shows its AMC reports only inside the AMC section (which is hidden from roles without AMC access)", () => {
  assert.match(unitPage, /amcVisible && \(data\.amcServiceReports \?\? \[\]\)\.length > 0/);
  assert.match(unitPage, /data-testid="unit-amc-reports"/);
});

test("page guard: a customer gets the portal and nothing else; staff get the signing screen without the application menu", () => {
  const access = read("apps/admin-web/src/lib/routeAccess.ts");
  assert.match(guard, /from "@\/lib\/routeAccess"/);
  assert.match(guard, /if \(pathname !== "\/customer\/portal"\) router\.push\("\/customer\/portal"\)/);
  assert.match(guard, /return isCustomerPortal \? \(/);
  assert.doesNotMatch(guard, /isCustomerReportPath/);
  assert.doesNotMatch(access, /isCustomerReportPath/, "the old customer report-page rule is gone");
  // the signing screen is a full-screen staff page: after the permission check, shown without the menu
  assert.match(access, /export function isInPersonSigningPath/);
  assert.match(guard, /if \(isInPersonSigningPath\(pathname\)\) \{\s*return <div className="min-h-screen bg-gray-50">\{children\}<\/div>;/);
  assert.ok(guard.lastIndexOf("isInPersonSigningPath(pathname)") > guard.indexOf("if (matched && !canAccess(user.permissions, matched))"), "the permission check comes first");
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
  assert.doesNotMatch(allReports, /isCustomer|\/service-reports\/mine/, "the list is a staff page: no customer branch");
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

test("direct reports on the screens: labelled apart from ticket and AMC reports, detail page and RECD unit history", () => {
  assert.match(detail, /"direct"/);
  assert.match(detail, /Direct service report/);
  assert.match(detail, /report\.kind === "direct" \? "← All service reports"/);
  assert.match(detail, /"Not recorded"/);
  assert.match(detail, /Submit for customer signature/);
  assert.match(signPage, /report\.kind === "amc" \? \["AMC order"/);
  assert.match(signPage, /"Direct service report"/);
  assert.match(unitPage, /directServiceReports/);
  assert.match(unitPage, /data-testid="unit-direct-reports"/);
  assert.match(unitPage, /unit-amc-reports-link|unit-amc-report-/, "the AMC and ticket report sections are kept");
  const ui = read("apps/admin-web/src/lib/serviceReportUi.ts");
  assert.match(ui, /reportKindLabel/);
  assert.match(ui, /"Direct"/);
});

test("signing a direct, ticket or AMC report uses the same in-person screen and the same signature pad (no second signature system)", () => {
  assert.doesNotMatch(directForm, /SignaturePad|signatureImage/);
  assert.equal((signPage.match(/<SignaturePad/g) ?? []).length, 1, "one signature pad, on the signing screen only");
  for (const f of ["AllServiceReports", "page", "[id]/page"]) {
    const src = read(`apps/admin-web/src/app/service-reports/${f}.tsx`);
    assert.doesNotMatch(src, /<SignaturePad/, f);
  }
  assert.match(signPage, /I have reviewed this report and approve it/);
  assert.match(signPage, /confirm: true/);
  assert.match(signPage, /report\.kind === "amc"/);
});
