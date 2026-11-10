import test from "node:test";
import assert from "node:assert/strict";
import {
  AMC_VISIT_STATUS,
  ACTIVE_REMINDER_STATUSES,
  BUSINESS_TIME_ZONE,
  ESCALATABLE_REMINDER_STATUSES,
  MAX_REMINDER_ESCALATION_LEVEL,
  addBusinessDays,
  businessDate,
  businessDayStart,
  businessDaysBetween,
  dueDateKey,
  REGION_MAPPABLE_ROLE_KEYS,
  classifyDue,
  createAmcVisitSchema,
  dueDayReached,
  escalationDue,
  reminderEligible,
  reminderPolicySchema,
  PROPOSED_REMINDER_POLICY,
  REMINDER_POLICY_DEFAULTS,
  setTicketDueDateSchema,
  updateAmcVisitSchema,
} from "../src/index";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

test("due state: a due date is an INDIAN calendar day - overdue only once that whole day (00:00 to 24:00 IST) has passed; no date is its own state", () => {
  const due = "2026-10-20"; // the day runs from 2026-10-19T18:30Z to 2026-10-20T18:30Z
  assert.equal(classifyDue(null, D("2026-10-20"), 3), "no_due_date");
  assert.equal(classifyDue(undefined, D("2026-10-20"), 3), "no_due_date");
  assert.equal(classifyDue("garbage", D("2026-10-20"), 3), "no_due_date");
  assert.equal(classifyDue(D(due), new Date("2026-10-19T18:29:59Z"), null), "pending", "still the 19th in India");
  assert.equal(classifyDue(D(due), new Date("2026-10-19T18:30:00Z"), null), "pending", "00:00 IST on the due date: due today, not overdue");
  assert.equal(classifyDue(D(due), new Date("2026-10-20T18:29:59Z"), null), "pending", "23:59:59 IST on the due date");
  assert.equal(classifyDue(D(due), new Date("2026-10-20T18:30:00Z"), null), "overdue", "00:00 IST the next day: the whole Indian day has passed");
  assert.equal(classifyDue(D(due), new Date("2026-11-30T00:00:00Z"), 3), "overdue");
});

test("due soon exists only when the policy sets a lead time", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  assert.equal(classifyDue(D("2026-10-19"), now, 3), "due_soon");
  assert.equal(classifyDue(D("2026-10-20"), now, 3), "due_soon", "exactly at the edge");
  assert.equal(classifyDue(D("2026-10-21"), now, 3), "pending");
  assert.equal(classifyDue(D("2026-10-19"), now, null), "pending", "no lead time approved: never 'due soon'");
  assert.equal(classifyDue(D("2026-10-19"), now, 0), "pending");
});

test("a reminder is created only with a due date AND an approved lead time, and only once due soon or overdue", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  assert.equal(reminderEligible(D("2026-10-10"), now, null), false, "policy off: even an overdue activity is not reminded");
  assert.equal(reminderEligible(null, now, 3), false, "no due date: nothing is invented");
  assert.equal(reminderEligible(D("2026-12-01"), now, 3), false, "far in the future");
  assert.equal(reminderEligible(D("2026-10-19"), now, 3), true);
  assert.equal(reminderEligible(D("2026-10-10"), now, 3), true);
});

test("escalation (approved policy): due exactly N hours after the due date BEGINS (00:00 IST) - never from the delivery - and acknowledging does not stop it", () => {
  const due = D("2026-10-17"); // the Indian date 17 October: it begins at 2026-10-16T18:30:00Z
  const begins = new Date("2026-10-16T18:30:00Z");
  const r = { status: "sent", dueDate: due, acknowledgedAt: null as Date | null, escalationLevel: 0 };
  const at = (h: number) => new Date(begins.getTime() + h * 3600 * 1000);
  assert.equal(escalationDue(r, null, at(500)), false, "no escalation time approved");
  assert.equal(escalationDue(r, 0, at(500)), false);
  assert.equal(escalationDue(r, 48, at(-24)), false, "before the due date");
  assert.equal(escalationDue(r, 48, at(47)), false);
  assert.equal(escalationDue(r, 48, new Date(at(48).getTime() - 1)), false, "one millisecond short of 48 hours");
  assert.equal(escalationDue(r, 48, at(48)), true, "exactly 48 hours after the due date began: 2026-10-18T18:30:00Z = 00:00 IST on the 19th");
  assert.equal(escalationDue(r, 48, new Date("2026-10-19T04:00:00Z")), true, "the daily 04:00 UTC (09:30 IST) run that day is the first one after it");
  assert.equal(escalationDue(r, 48, new Date("2026-10-18T04:00:00Z")), false, "the run the day before is too early");
  assert.equal(escalationDue(r, 48, at(500)), true, "and every run after it until it has been delivered");
  assert.equal(escalationDue({ ...r, dueDate: due.toISOString() }, 48, at(48)), true, "a due date given as text works the same");
  assert.equal(escalationDue({ ...r, dueDate: "garbage" }, 48, at(500)), false);
  assert.equal(escalationDue({ ...r, acknowledgedAt: at(1) }, 48, at(500)), true, "ACKNOWLEDGED does not stop the escalation (the owner's decision)");
  assert.equal(escalationDue({ ...r, status: "acknowledged" }, 48, at(500)), true, "the status 'acknowledged' is escalated like 'sent'");
  for (const status of ["pending", "sending", "closed"]) assert.equal(escalationDue({ ...r, status }, 48, at(500)), false, status);
  assert.equal(escalationDue({ ...r, escalationLevel: MAX_REMINDER_ESCALATION_LEVEL }, 48, at(900)), false, "a single escalation: once it has been delivered it is never due again");
});

test("both Service Managers and Regional Managers can be mapped to a region - nobody else", () => {
  assert.deepEqual([...REGION_MAPPABLE_ROLE_KEYS].sort(), ["regional_manager", "service_manager"]);
});

test("input schemas: real calendar dates only, due dates can be cleared, AMC visits take only the order, the unit and a date", () => {
  assert.equal(setTicketDueDateSchema.safeParse({ dueDate: "2026-11-05" }).success, true);
  assert.equal(setTicketDueDateSchema.safeParse({ dueDate: null }).success, true);
  for (const bad of ["05-11-2026", "2026-02-30", "2026-13-01", "soon", "", 5, undefined]) assert.equal(setTicketDueDateSchema.safeParse({ dueDate: bad }).success, false, String(bad));
  const visit = createAmcVisitSchema.parse({ amcOrderId: "a", unitId: "u", dueDate: "2026-11-05", customerId: "cB", siteId: "sB", serialNo: "FAKE" });
  assert.deepEqual(Object.keys(visit).sort(), ["amcOrderId", "dueDate", "unitId"]);
  assert.equal(createAmcVisitSchema.safeParse({ amcOrderId: "a", unitId: "u" }).success, false, "a visit without a due date is not trackable");
  assert.equal(updateAmcVisitSchema.safeParse({}).success, false);
  assert.equal(updateAmcVisitSchema.safeParse({ status: AMC_VISIT_STATUS.COMPLETED }).success, true);
  assert.equal(updateAmcVisitSchema.safeParse({ status: "scheduled" }).success, false, "cannot be set back to scheduled");
});

test("reminder policy: empty = off; values are bounded", () => {
  assert.equal(reminderPolicySchema.safeParse({ reminderLeadDays: null, reminderEscalationHours: null }).success, true);
  assert.equal(reminderPolicySchema.safeParse({ reminderLeadDays: 0, reminderEscalationHours: 1 }).success, true);
  for (const bad of [{ reminderLeadDays: -1 }, { reminderLeadDays: 366 }, { reminderLeadDays: 1.5 }, { reminderEscalationHours: 0 }, { reminderEscalationHours: 100000 }, { reminderLeadDays: "3" }]) {
    assert.equal(reminderPolicySchema.safeParse({ reminderLeadDays: 3, reminderEscalationHours: null, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(reminderPolicySchema.safeParse({}).success, false, "both fields must be stated, so switching off is deliberate");
});

test("the approved workflow (2 days, 48 hours after the due date) is a valid policy, but it is only pre-filled in Settings: the stored default stays OFF", () => {
  assert.equal(PROPOSED_REMINDER_POLICY.reminderLeadDays, 2, "the proposed / default lead time is 2 days before the due date");
  assert.equal(PROPOSED_REMINDER_POLICY.reminderEscalationHours, 48, "escalation 48 hours after the due date");
  assert.deepEqual({ ...PROPOSED_REMINDER_POLICY }, { reminderLeadDays: 2, reminderEscalationHours: 48 });
  assert.equal(MAX_REMINDER_ESCALATION_LEVEL, 1, "a single escalation");
  assert.equal(reminderPolicySchema.safeParse(PROPOSED_REMINDER_POLICY).success, true);
  assert.deepEqual({ ...REMINDER_POLICY_DEFAULTS }, { reminderLeadDays: null, reminderEscalationHours: null });
});

test("the approved lead time: eligible from 2 INDIAN calendar days before the due date (00:00 IST), not before", () => {
  const due = new Date("2026-10-22T00:00:00.000Z"); // an Indian date, stored at UTC midnight
  const at = (iso: string) => new Date(iso);
  const lead = PROPOSED_REMINDER_POLICY.reminderLeadDays;
  assert.equal(lead, 2);
  assert.equal(reminderEligible(due, at("2026-10-19T18:30:00.000Z"), lead), true, "00:00 IST on the 20th = exactly 2 days before");
  assert.equal(reminderEligible(due, at("2026-10-20T10:00:00.000Z"), lead), true);
  assert.equal(reminderEligible(due, at("2026-10-19T18:29:59.000Z"), lead), false, "one second earlier it is still the 19th in India: 3 days before");
  assert.equal(reminderEligible(due, at("2026-10-25T00:00:00.000Z"), lead), true, "overdue activities are always eligible");
  assert.equal(reminderEligible(due, at("2026-10-19T00:00:00.000Z"), null), false, "policy off: never");
});

test("escalationDue: a reminder whose delivery failed (failed / no recipient) is escalated at the same moment - the due date is the only clock; an attempted escalation stays due", () => {
  const due = D("2026-01-01");
  const begins = new Date("2025-12-31T18:30:00Z"); // 00:00 IST on 1 January
  const at = (h: number) => new Date(begins.getTime() + h * 3600 * 1000);
  const base = { escalationLevel: 0, dueDate: due };
  for (const status of ["sent", "acknowledged", "failed", "no_recipient"]) {
    const r = { ...base, status };
    assert.equal(escalationDue(r, 48, at(47)), false, status + ": too early");
    assert.equal(escalationDue(r, 48, at(48)), true, status + ": due, whether or not the first reminder was ever delivered");
    assert.equal(escalationDue(r, 24, at(24)), true, status + ": the hours are the configured value, not a fixed 48");
    assert.equal(escalationDue(r, null, at(500)), false, "policy off");
  }
  assert.equal(escalationDue({ ...base, status: "sent", escalationAttempts: 1 }, 48, at(1)), true, "an escalation that was already attempted (its delivery failed) stays due until delivered");
});

test("dueDayReached: today (in India) is the due date or later - the day the due-date reminder and every daily reminder after it go out", () => {
  const due = D("2026-10-20");
  assert.equal(dueDayReached(due, new Date("2026-10-19T18:29:59Z")), false, "23:59:59 IST the day before");
  assert.equal(dueDayReached(due, new Date("2026-10-19T18:30:00Z")), true, "the due date itself, from 00:00 IST");
  assert.equal(dueDayReached(due, new Date("2026-10-20T04:00:00Z")), true, "the daily 04:00 UTC (09:30 IST) run on the due date");
  assert.equal(dueDayReached(due, new Date("2026-10-20T18:29:59Z")), true, "until its last second");
  assert.equal(dueDayReached(due, new Date("2026-10-27T04:00:00Z")), true, "any later day");
  assert.equal(dueDayReached("2026-10-20T00:00:00.000Z", new Date("2026-10-20T04:00:00Z")), true, "a due date given as text");
  assert.equal(dueDayReached(null, new Date()), false);
  assert.equal(dueDayReached(undefined, new Date()), false);
  assert.equal(dueDayReached("garbage", new Date()), false);
});

test("business time (India Standard Time, a fixed +05:30): the Indian date of an instant, when a day begins, and whole-day arithmetic", () => {
  assert.equal(BUSINESS_TIME_ZONE, "Asia/Kolkata");
  assert.equal(businessDate(new Date("2026-10-19T18:29:59Z")), "2026-10-19");
  assert.equal(businessDate(new Date("2026-10-19T18:30:00Z")), "2026-10-20", "18:30 UTC is midnight in India");
  assert.equal(businessDate(new Date("2026-10-20T04:00:00Z")), "2026-10-20", "the 04:00 UTC cron is 09:30 IST, the same date");
  assert.equal(businessDate(new Date("2026-12-31T20:00:00Z")), "2027-01-01", "across a year boundary");
  assert.equal(businessDayStart("2026-10-20").toISOString(), "2026-10-19T18:30:00.000Z");
  assert.equal(businessDate(businessDayStart("2026-03-01")), "2026-03-01", "round trip");
  assert.equal(businessDaysBetween("2026-10-20", "2026-10-23"), 3);
  assert.equal(businessDaysBetween("2026-10-23", "2026-10-20"), -3);
  assert.equal(businessDaysBetween("2026-02-27", "2026-03-02"), 3, "across the end of February");
  assert.equal(addBusinessDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addBusinessDays("2026-12-30", 3), "2027-01-02");
  assert.equal(dueDateKey(D("2026-10-20")), "2026-10-20");
  assert.equal(dueDateKey("2026-10-20T00:00:00.000Z"), "2026-10-20");
  assert.equal(dueDateKey(null), null);
  assert.equal(dueDateKey("garbage"), null);
});

test("acknowledged reminders stay in the active set: they keep being reminded and escalated (only finishing the activity stops them)", () => {
  assert.ok(ACTIVE_REMINDER_STATUSES.includes("sent") && ACTIVE_REMINDER_STATUSES.includes("acknowledged"));
  assert.ok(ESCALATABLE_REMINDER_STATUSES.includes("acknowledged"));
  assert.ok(!ESCALATABLE_REMINDER_STATUSES.includes("closed") && !ESCALATABLE_REMINDER_STATUSES.includes("pending"));
});
