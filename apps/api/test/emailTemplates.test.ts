// Pure rendering tests for the ticket e-mail templates. No database, no SMTP: nothing is sent anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { renderEmail } from "../src/services/notifications/emailTemplates";

const EVIL = `<script>alert("x")</script>&`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;";

test("complaint_status_updated: dedicated subject, ticket number and readable status", () => {
  const m = renderEmail("complaint_status_updated", { ticketNumber: "TCK-2026-12345", status: "in_progress" });
  assert.match(m.subject, /update on your service ticket TCK-2026-12345/);
  assert.ok(m.text.includes("TCK-2026-12345"));
  assert.ok(m.text.includes("New status: in progress"));
  assert.ok(m.html.includes("TCK-2026-12345") && m.html.includes("New status: in progress"));
  assert.ok(!m.text.includes("Complaint Status Updated"), "must not use the generic fallback");
});

test("complaint_status_updated: includes the serial when the payload has one, and escapes HTML", () => {
  const m = renderEmail("complaint_status_updated", { ticketNumber: EVIL, status: EVIL, serialNo: EVIL });
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes(ESCAPED));
  assert.ok(m.text.includes("RECD serial no."));
});

test("complaint_assigned: dedicated subject, ticket number and a next step", () => {
  const m = renderEmail("complaint_assigned", { ticketNumber: "TCK-2026-12345" });
  assert.match(m.subject, /service ticket TCK-2026-12345 assigned to you/);
  assert.ok(m.text.includes("Next step:"));
  assert.ok(m.html.includes("Next step:"));
  assert.ok(!m.text.includes("Complaint Assigned"), "must not use the generic fallback");
});

test("complaint_assigned: optional customer / serial shown, and HTML is escaped", () => {
  const m = renderEmail("complaint_assigned", { ticketNumber: EVIL, customerName: EVIL, serialNo: EVIL });
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes(ESCAPED));
  assert.ok(m.text.includes("Customer:"));
});

test("generic fallback: still renders unknown templates, with keys and values escaped", () => {
  const m = renderEmail("some_new_template", { note: EVIL, [`<b>k</b>`]: "v" });
  assert.match(m.subject, /Some New Template/);
  assert.ok(m.text.includes("note: "));
  assert.ok(!m.html.includes("<script>"));
  assert.ok(!m.html.includes("<b>k</b>"));
  assert.ok(m.html.includes(ESCAPED));
  assert.ok(m.html.includes("&lt;b&gt;k&lt;/b&gt;"));
});

test("service_reminder: a daily overdue reminder says it is overdue and for how many days; a first reminder has no such line", () => {
  const base = { activityType: "ticket", activityRef: "TCK-1", customerName: "Acme", siteName: "Plant", serialNo: "SN1", dueDate: "2031-06-10" };
  const daily = renderEmail("service_reminder", { ...base, overdue: true, daysOverdue: 3, repeat: true });
  assert.match(daily.text, /Overdue: Service ticket TCK-1/);
  assert.match(daily.text, /Due date: 2031-06-10 \(OVERDUE\)/);
  assert.match(daily.text, /Days overdue: 3/);
  assert.ok(daily.html.includes("Days overdue: 3"));
  const first = renderEmail("service_reminder", { ...base, overdue: false });
  assert.match(first.text, /Due soon: Service ticket TCK-1/);
  assert.ok(!first.text.includes("Days overdue"));
});
