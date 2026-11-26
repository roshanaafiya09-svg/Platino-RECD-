// Service-report links and staff list (Requirement 4). The repo has no component-test runner, so the screens are checked at source level
// (reading the files as text) and the pure helpers are run directly. Trying the pages in a real browser has NOT been done by these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as access from "../src/lib/routeAccess";
import { isInPersonSigningPath, SERVICE_REPORT_LIST_PERMISSIONS } from "../src/lib/routeAccess";
import { EMPTY_REPORT_FILTERS, REPORT_LIST_PAGE_SIZE, cleanReportId, pageRange, reportListQuery, reportSource } from "../src/lib/serviceReportList";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const nav = read("apps/admin-web/src/components/Nav.tsx");
const portal = read("apps/admin-web/src/app/customer/portal/page.tsx");
const page = read("apps/admin-web/src/app/service-reports/page.tsx");
const all = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");
const unitPage = read("apps/admin-web/src/app/recd-units/[id]/page.tsx");
const complaints = read("apps/admin-web/src/app/complaints/page.tsx");
const remindersApi = read("apps/api/src/routes/reminders.ts");

test("a customer may open the portal only - the old customer report-page rule is gone; the in-person signing page has its own exact rule", () => {
  assert.equal((access as Record<string, unknown>).isCustomerReportPath, undefined, "no helper lets a customer onto a report page any more");
  for (const yes of ["/service-reports/ckabc123/sign", "/service-reports/ckabc123/sign/"]) assert.equal(isInPersonSigningPath(yes), true, yes);
  for (const no of ["/", "/service-reports", "/service-reports/ckabc123", "/service-reports/sign", "/service-reports/a/sign/b", "/service-reports/ckabc123/pdf", "/customer/portal", "/service-reports-evil/x/sign", "/x/service-reports/a/sign"]) {
    assert.equal(isInPersonSigningPath(no), false, no);
  }
});

test("the customer portal renders no service-report link at all (nothing for a customer to bounce off, nothing that tells them to sign there)", () => {
  assert.doesNotMatch(portal, /service-reports/);
  assert.doesNotMatch(portal, /Service reports &amp; signing|Review & sign/);
});

test("the guard sends every customer to the portal and renders only the portal for them; the signing page is for staff", () => {
  assert.match(guard, /import \{ isInPersonSigningPath, SERVICE_REPORT_LIST_PERMISSIONS \} from "@\/lib\/routeAccess"/);
  assert.match(guard, /pathname !== "\/customer\/portal"\) router\.push\("\/customer\/portal"\)/);
  assert.match(guard, /return isCustomerPortal \? \(/);
  assert.doesNotMatch(guard, /isCustomerReportPath/);
  assert.doesNotMatch(guard, /function isInPersonSigningPath/, "one shared rule, not a second copy");
});

test("staff: the report list has a menu entry and a route rule, both limited to people who hold a ticket or AMC permission", () => {
  assert.deepEqual([...SERVICE_REPORT_LIST_PERMISSIONS].sort(), ["act_assigned_complaints", "manage_amc_orders", "manage_complaints", "view_complaints_overview"]);
  assert.match(guard, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  assert.match(nav, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  assert.match(nav, /href: "\/service-reports", label: "Service reports"/);
});

test("links from other screens still point at the per-ticket / per-AMC lists and single reports, as before", () => {
  assert.match(complaints, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.match(unitPage, /\/service-reports\/\$\{r\.id\}/);
  assert.match(remindersApi, /\/service-reports\?complaintId=\$\{r\.activityId\}/, "the reminders API link for a ticket (staff)");
  assert.match(page, /if \(!params\.get\("complaintId"\) && !params\.get\("amcOrderId"\)\) return <AllServiceReports \/>/, "no ticket / AMC order in the address -> the list");
});

test("the list screen: staff read the scoped list with filters and paging; there is no customer branch and no create form that bypasses the source record", () => {
  assert.doesNotMatch(all, /\/service-reports\/mine|isCustomer/);
  assert.match(all, /`\/service-reports\?\$\{reportListQuery\(filters\)\}`/);
  assert.match(all, /<form/, "the filters");
  assert.match(all, /data-testid="reports-paging"/);
  assert.doesNotMatch(all, /method: "POST"/, "listing never writes");
  for (const col of ["Report", "For", "Customer / site", "RECD serial", "Status"]) assert.match(all, new RegExp(col), col);
  assert.match(all, /Serial not entered/, "a legacy unit without a serial reads clearly");
});

test("reportListQuery: only known values reach the address; paging is bounded; free text is trimmed and capped", () => {
  assert.equal(reportListQuery(EMPTY_REPORT_FILTERS), `limit=${REPORT_LIST_PAGE_SIZE}&offset=0`);
  assert.equal(
    reportListQuery({ ...EMPTY_REPORT_FILTERS, status: "signed", kind: "amc", q: "  SN-1  ", offset: 50 }),
    `status=signed&kind=amc&q=SN-1&limit=${REPORT_LIST_PAGE_SIZE}&offset=50`,
  );
  assert.equal(reportListQuery({ ...EMPTY_REPORT_FILTERS, status: "approved", kind: "other", q: "", offset: -5 }), `limit=${REPORT_LIST_PAGE_SIZE}&offset=0`, "unknown status / kind and a negative offset are dropped");
  assert.ok(reportListQuery({ ...EMPTY_REPORT_FILTERS, q: "x".repeat(500) }).includes(`q=${"x".repeat(100)}&`));
  assert.ok(!reportListQuery({ ...EMPTY_REPORT_FILTERS, q: "a&status=signed" }).includes("&status=signed"), "the search text cannot inject another filter");
});

test("reportListQuery: customer, site and DG (unit) filters are sent as ids only; anything that is not an id is dropped", () => {
  assert.equal(
    reportListQuery({ ...EMPTY_REPORT_FILTERS, customerId: "cust_1", siteId: "site-2", unitId: "unit3" }),
    `customerId=cust_1&siteId=site-2&unitId=unit3&limit=${REPORT_LIST_PAGE_SIZE}&offset=0`,
  );
  assert.equal(reportListQuery({ ...EMPTY_REPORT_FILTERS, customerId: "a&status=signed", siteId: "x y", unitId: "../etc" }), `limit=${REPORT_LIST_PAGE_SIZE}&offset=0`, "no injection through the id filters");
  assert.equal(cleanReportId(null), "");
  assert.equal(cleanReportId("clx0abc123"), "clx0abc123");
  assert.equal(cleanReportId("a".repeat(65)), "");
});

test("reportSource and pageRange: the labels the list shows", () => {
  assert.equal(reportSource({ kind: "ticket", ticketNumber: "TCK-1", amc: null }), "TCK-1");
  assert.equal(reportSource({ kind: "amc", ticketNumber: null, amc: { ref: "AMC-ABC123" } }), "AMC AMC-ABC123");
  assert.equal(reportSource({ kind: "ticket", ticketNumber: null, amc: null }), "Ticket");
  assert.equal(pageRange(0, 25, 60), "1-25 of 60");
  assert.equal(pageRange(50, 10, 60), "51-60 of 60");
  assert.equal(pageRange(0, 0, 0), "0 of 0");
});
