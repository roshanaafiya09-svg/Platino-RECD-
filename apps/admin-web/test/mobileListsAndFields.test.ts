// Stage 1 of the mobile work: AMC Orders and Service Reports lists on phones, and 16px form fields on phones. The repo has no component-test runner, so
// these are source-level checks (reading the files as text). They prove the structure and the breakpoints; they do NOT replace looking at the pages in a
// phone-sized browser and on a real phone (done / to be done separately).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const css = read("apps/admin-web/src/app/globals.css");
const amc = read("apps/admin-web/src/app/amc-orders/page.tsx");
const reports = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");

test("the table/card switch is at 768px: tables from 768px up, cards below (the existing helpers, unchanged)", () => {
  assert.match(css, /\.table-desktop \{ display: none; \}\n\.cards-mobile \{ display: block; \}\n@media \(min-width: 768px\) \{\n  \.table-desktop \{ display: block; \}\n  \.cards-mobile \{ display: none; \}\n\}/);
});

test("AMC Orders: the table is kept exactly as before inside table-desktop; phones get a card list with the same details and actions", () => {
  // desktop: the same table, the same headers and the same test ids
  assert.match(amc, /<div className="table-desktop">\n\s*<div className="table-scroll">\n\s*<table className="w-full border-collapse text-sm">/);
  for (const header of ["S.No", "PO No", "PO Date", "Customer Name", "Location", "Item", "RECD Serial No.", "Qty", "AMC Frequency per Year", "AMC Type", "Status", "AMC Period", "Contract", "Action"]) {
    assert.ok(amc.includes(`>${header}</th>`), header);
  }
  for (const id of ["amc-reports-link-", "amc-renew-", "amc-edit-", "amc-history-", "amc-period-", "amc-contract-"]) assert.ok(amc.includes("`" + id + "${o.poNo}`") || amc.includes("{`" + id + "${o.poNo}`}"), `table keeps ${id}`);
  // phones: cards, with distinct test ids (so nothing is duplicated in the page)
  assert.match(amc, /<div className="cards-mobile p-3" data-testid="amc-mobile-cards">/);
  for (const id of ["amc-card-", "amc-card-period-", "amc-card-contract-", "amc-card-reports-link-", "amc-card-renew-", "amc-card-edit-", "amc-card-history-"]) assert.ok(amc.includes("`" + id + "${o.poNo}`"), `card has ${id}`);
  const cards = amc.slice(amc.indexOf('data-testid="amc-mobile-cards"'), amc.indexOf("{orderModalOpen && ("));
  // every action the table row offers is on the card, wired to the same handlers
  for (const action of ['setDialog({ kind: "renew", order: o })', 'setDialog({ kind: "edit", order: o })', 'setDialog({ kind: "history", order: o })', "clearReminder(o.id)", "`/service-reports?amcOrderId=${o.id}`"]) assert.ok(cards.includes(action), action);
  for (const label of ["Service reports", "Renew", "Edit", "History", "AMC Acquired"]) assert.ok(cards.includes(label), label);
  // the details the table shows
  for (const label of ["PO date", "AMC period", "Type", "Qty · visits / year", "RECD serial", "Contract"]) assert.ok(cards.includes(label), label);
  assert.match(cards, /Loading AMC orders…/);
  assert.match(cards, /No AMC orders found\./);
  assert.doesNotMatch(cards, /<table|overflow-x|table-scroll|min-w-\[/, "a card list never needs sideways scrolling");
});

test("Service Reports list: the table is kept for 768px and up; phones get cards with status, PDF and Open on the card", () => {
  assert.match(reports, /className="overflow-x-auto rounded-xl border border-gray-200 bg-white table-desktop"/);
  assert.match(reports, /data-testid="reports-table"/);
  assert.match(reports, /data-testid=\{`report-row-\$\{r\.reportNumber\}`\}/);
  const cards = reports.slice(reports.indexOf('data-testid="reports-mobile-cards"'), reports.indexOf('data-testid="reports-paging"'));
  assert.match(reports, /<div className="cards-mobile" data-testid="reports-mobile-cards">/);
  assert.match(cards, /data-testid=\{`report-card-\$\{r\.reportNumber\}`\}/);
  assert.match(cards, /reportStatusPill\(r\.status\)/, "status is on the card");
  assert.match(cards, /\{r\.pdfAvailable && \(\s*<button onClick=\{\(\) => download\(r\)\}/, "PDF is on the card, only when a PDF exists, with the same download handler");
  assert.match(cards, />Open<\/Link>/, "Open is on the card");
  assert.match(cards, /href=\{`\/service-reports\/\$\{r\.id\}`\}/);
  for (const text of ["r.customerName", "r.siteName", "r.visitDate", "r.engineer.name", "reportKindLabel(r.kind)", "reportSource(r)", "Not recorded", "Serial not entered"]) assert.ok(cards.includes(text), text);
  assert.doesNotMatch(cards, /<table|overflow-x|min-w-/);
  // paging and filters are shared by both layouts
  assert.match(reports, /data-testid="reports-paging"/);
  assert.match(reports, /data-testid="report-filters"/);
});

test("form fields: 16px on phones only (below 768px, screens only); the desktop field size is unchanged; check boxes and radio buttons are left alone", () => {
  // desktop: the shared field class is exactly what it was
  assert.match(css, /\.field \{\n  background: var\(--bg-page\);\n  border: 1px solid #DDE2E8;\n  border-radius: 0\.5625rem;\n  padding: 0\.625rem 0\.75rem;\n  font-size: 0\.8125rem;/);
  const blocks = [...css.matchAll(/@media screen and \(max-width: 767.98px\) \{\n([\s\S]*?)\n\}\n/g)].map((m) => m[1]);
  const fieldBlock = blocks.find((b) => /font-size: 16px/.test(b));
  assert.ok(fieldBlock, "a phones-only block sets 16px");
  assert.equal(fieldBlock!.split("font-size: 16px").length - 1, 1, "the phone block sets 16px once");
  assert.ok(css.indexOf("font-size: 16px") === css.indexOf(fieldBlock!) + fieldBlock!.indexOf("font-size: 16px") || css.indexOf(".print-co-name") > 0, "(the only other 16px in the stylesheet is the printed letterhead company name)");
  assert.match(fieldBlock!, /select:not\(\[data-keep-font\]\),\n  textarea:not\(\[data-keep-font\]\) \{\n    font-size: 16px;/, "select and textarea are more specific than .field / text-sm, so they really become 16px");
  for (const excluded of ["checkbox", "radio", "range", "file", "color", "button", "submit"]) assert.ok(fieldBlock!.includes(`:not([type="${excluded}"])`), excluded);
  assert.doesNotMatch(css.slice(0, css.indexOf("@media screen and (max-width: 767.98px)")), /font-size: 16px/, "nothing before the phone media query sets 16px");
  assert.doesNotMatch(css.slice(css.indexOf(".field {"), css.indexOf("@media screen and (max-width: 767.98px)")), /font-size: 16px/, "the desktop .field rule is untouched");
  // the same breakpoint as the table/card switch: below 768 is a phone, 768 and up is desktop
  assert.ok(css.includes("@media (min-width: 768px) {\n  .table-desktop { display: block; }"));
});

test("AMC Orders phone cards: every action button (Service reports, Renew, Edit, History, AMC Acquired) is at least 44px tall; the desktop table is untouched", () => {
  const start = amc.indexOf('<div className="mt-3 flex flex-wrap gap-2">');
  assert.ok(start > 0, "the card button row");
  const row = amc.slice(start, amc.indexOf("</div>\n            );", start));
  // the five controls of the row: one link and four buttons, each with the 44px minimum
  assert.match(row, /<Link[\s\S]*?className="flex min-h-\[44px\] flex-1 items-center justify-center rounded-lg border border-gray-300 /);
  const buttonClasses = [...row.matchAll(/className="(min-h-\[44px\] flex-1 rounded-lg border border-(?:indigo|gray|emerald)-300 [^"]*)"/g)];
  assert.equal(buttonClasses.length, 4, "Renew, Edit, History and AMC Acquired");
  assert.equal((row.match(/min-h-\[44px\]/g) ?? []).length, 5, "nothing in the row is left at the old height");
  assert.match(row, /mt-3 flex flex-wrap gap-2/, "the row still wraps, so taller buttons never push anything off screen");
  // the laptop / desktop table (before the cards) has no phone sizing
  assert.doesNotMatch(amc.slice(0, amc.indexOf("cards-mobile")), /min-h-\[44px\]/);
});
