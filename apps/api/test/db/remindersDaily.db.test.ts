/**
 * Real-database tests for the DAILY OVERDUE reminders of Requirement 6: the first reminder follows the configured lead time (2 days here,
 * and 3 for the proposed policy), then - once the due date has passed - the same recipients are reminded once per UTC day until the ticket
 * is resolved / closed / archived or the reminder is acknowledged; a second or simultaneous run never repeats a day; failed deliveries and
 * missing recipients are retried correctly; escalation and the existing retry rules are untouched.
 *
 * Time is simulated: every job run is given an explicit "now" (days apart). The e-mail provider is replaced by a stub that records what
 * it was asked to send (nothing leaves this process); WhatsApp / SMS are stubs.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; removed in `after`). The
 * company-settings singleton row is changed for the run and restored.
 */
import "dotenv/config";
import test, { describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const ISOLATED = { hosts: ["localhost", "127.0.0.1"], port: "5434", database: "platino_test" };

function pointsAtIsolatedDb(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return ISOLATED.hosts.includes(u.hostname) && u.port === ISOLATED.port && u.pathname === `/${ISOLATED.database}`;
  } catch {
    return false;
  }
}

const isolated = pointsAtIsolatedDb(process.env.DATABASE_URL) && pointsAtIsolatedDb(process.env.DIRECT_URL) && !!process.env.JWT_SECRET;
const skip = isolated
  ? false
  : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";describe("daily overdue reminders against the real test database", { skip }, () => {
  const PREFIX = `ZY${Date.now().toString(36).toUpperCase()}`;
  const DAY = 24 * 3600 * 1000;
  const T0 = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  /** A simulated job run: `n` days from today at 04:00 UTC (the hour the cron runs), plus optional extra hours. */
  const runAt = (n: number, extraHours = 0) => new Date(T0.getTime() + n * DAY + (4 + extraHours) * 3600 * 1000);
  const dueOn = (n: number) => new Date(T0.getTime() + n * DAY); // a due date is a calendar day (UTC midnight)
  const dayOf = (n: number, extraHours = 0) => runAt(n, extraHours).toISOString().slice(0, 10);
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), regionIds: new Set<string>(), unitIds: new Set<string>(), complaintIds: new Set<string>() };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };
  const savedEnv: Record<string, string | undefined> = {};

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let runReminderJob: (now?: Date) => Promise<any>;
  let productId = "";
  let stageId = "";
  const roleIds: Record<string, string> = {};
  let savedSettings: any = null;
  const W: Record<string, any> = {};
  const emailFail = new Set<string>();
  /** Every e-mail the stub accepted: who, which template, and the data the template received. */
  let mails: { to: string; template: string; data: any }[] = [];
  let realEmailProvider: any = null;
  let providers: any = null;
  let startedAt = new Date();

  async function makeUser(tag: string, roleKey: string) {
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, email: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false } });
    tracked.userIds.add(u.id);
    return u;
  }
  async function makeRegion(tag: string) {
    const r = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-${tag}`, name: `${PREFIX} ${tag}` } });
    tracked.regionIds.add(r.id);
    return r;
  }
  async function makeCustomer(tag: string, region: any) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag} Ltd` } });
    tracked.customerIds.add(customer.id);
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 1, site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, regionId: region?.id ?? null } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const newUnit = async () => {
      const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-${tag}-SN${++seq}`, orderId: order.id, siteId: order.site.id, productId } });
      tracked.unitIds.add(unit.id);
      return unit;
    };
    return { customer, order, site: order.site, newUnit };
  }
  async function makeTicket(w: any, dueDate: Date | null, status = "open") {
    const unit = await w.newUnit();
    const t = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.customer.id, siteId: w.site.id, unitId: unit.id, category: "non_performance", description: `${PREFIX} ticket`, severity: "medium", status, dueDate } });
    tracked.complaintIds.add(t.id);
    return t;
  }
  const setPolicy = (lead: number | null, hours: number | null) =>
    prisma.companySettings.upsert({ where: { id: "singleton" }, update: { reminderLeadDays: lead, reminderEscalationHours: hours }, create: { id: "singleton", reminderLeadDays: lead, reminderEscalationHours: hours } });
  const reminderOf = (complaintId: string) => prisma.serviceReminder.findUnique({ where: { complaintId } });
  const eventsOf = async (reminderId: string, type: string) => prisma.serviceReminderEvent.findMany({ where: { reminderId, type }, orderBy: { createdAt: "asc" } });
  const mailsTo = (userId: string, template = "service_reminder") => mails.filter((m) => m.to === userId && m.template === template);
  const tokenOf = (u: any) => signToken({ userId: u.id, roleKey: "x", customerId: u.customerId ?? null });
  async function call(as: any, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf(as)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  }

  before(async () => {
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ runReminderJob } = await import("../../src/lib/reminders"));
    ({ providersByChannel: providers } = await import("../../src/services/notifications/providers"));
    realEmailProvider = providers.email;
    providers.email = { channel: "email", send: async ({ recipientId, templateKey, data }: any) => { if (emailFail.has(recipientId)) return false; mails.push({ to: recipientId, template: templateKey, data }); return true; } };
    startedAt = new Date();
    const { remindersRouter } = await import("../../src/routes/reminders");
    const app = express();
    app.use(express.json());
    app.use("/reminders", remindersRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    savedSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["service_manager", "regional_manager", "management", "owner_admin"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    W.north = await makeRegion("North");
    W.east = await makeRegion("East"); // no manager mapped
    W.sm1 = await makeUser("sm1", "service_manager");
    W.sm2 = await makeUser("sm2", "service_manager");
    W.rm = await makeUser("rm", "regional_manager");
    W.mgmt = await makeUser("mgmt", "management");
    await prisma.regionManager.createMany({ data: [{ regionId: W.north.id, userId: W.sm1.id }, { regionId: W.north.id, userId: W.rm.id }] });
    W.northCo = await makeCustomer("N", W.north);
    W.eastCo = await makeCustomer("E", W.east);
    W.admin = await prisma.user.findUniqueOrThrow({ where: { email: "superadmin@platino.example" } });
  });

  beforeEach(() => {
    mails = [];
    emailFail.clear();
  });

  // Every test starts from a clean slate: earlier tests' reminders are removed and their tickets resolved, so a later simulated day does not
  // remind about them again (the counts below are exact).
  afterEach(async () => {
    const ids = [...tracked.complaintIds];
    await prisma.serviceReminder.deleteMany({ where: { complaintId: { in: ids } } });
    await prisma.complaint.updateMany({ where: { id: { in: ids } }, data: { status: "resolved", closedAt: new Date() } });
  });

  after(async () => {
    server?.close();
    if (providers && realEmailProvider) providers.email = realEmailProvider;
    try {
      if (prisma) {
        await prisma.notificationLog.deleteMany({ where: { templateKey: { startsWith: "service_reminder" }, createdAt: { gte: startedAt } } });
        if (savedSettings) await prisma.companySettings.update({ where: { id: "singleton" }, data: { reminderLeadDays: savedSettings.reminderLeadDays, reminderEscalationHours: savedSettings.reminderEscalationHours } });
        else await prisma.companySettings.deleteMany({ where: { id: "singleton", legalName: null, logoDataUrl: null } }).catch(() => {});
        const complaintIds = [...tracked.complaintIds];
        const userIds = [...tracked.userIds];
        await prisma.serviceReminder.deleteMany({ where: { OR: [{ complaintId: { in: complaintIds } }, { customerId: { in: [...tracked.customerIds] } }] } });
        await prisma.complaint.deleteMany({ where: { id: { in: complaintIds } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.notificationLog.deleteMany({ where: { recipientId: { in: userIds } } });
        await prisma.region.deleteMany({ where: { id: { in: [...tracked.regionIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
      for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    }
  });

  // ------------------------------------------------------------------------------------------

  test("lead time: with 2 days the first reminder appears 2 days before the due date (not 3); with 3 days it appears 3 days before", async () => {
    await setPolicy(2, null);
    const t2 = await makeTicket(W.northCo, dueOn(40));
    await runReminderJob(runAt(36)); // 4 days before
    await runReminderJob(runAt(37)); // 3 days before
    assert.equal(await reminderOf(t2.id), null, "nothing 3 or 4 days before when the lead time is 2");
    await runReminderJob(runAt(38)); // 2 days before
    assert.equal((await reminderOf(t2.id))?.status, "sent", "created and delivered 2 days before");
    assert.equal(mailsTo(W.sm1.id).length, 1);

    await setPolicy(3, null);
    const t3 = await makeTicket(W.northCo, dueOn(60));
    await runReminderJob(runAt(56)); // 4 days before
    assert.equal(await reminderOf(t3.id), null);
    await runReminderJob(runAt(57)); // 3 days before
    assert.equal((await reminderOf(t3.id))?.status, "sent", "with the proposed 3-day policy it appears 3 days before");
  });

  test("daily: the first reminder at the lead time, then NOTHING until the due date has passed, then one reminder every day, each saying how many days overdue", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(100));
    for (const n of [97, 98, 99, 100]) await runReminderJob(runAt(n)); // 3 days before ... the due day itself
    const rem = await reminderOf(t.id);
    assert.equal(mailsTo(W.sm1.id).length, 1, "one reminder in the lead window; none on the due day itself (it is not overdue until the day has passed)");
    assert.equal(mailsTo(W.sm1.id)[0].data.overdue, false);
    const firstSentAt = rem.sentAt;

    for (const n of [101, 102, 103, 104, 105]) await runReminderJob(runAt(n));
    const sent = mailsTo(W.sm1.id);
    assert.equal(sent.length, 6, "1 first reminder + one for each of the 5 overdue days");
    assert.deepEqual(sent.slice(1).map((m) => m.data.daysOverdue), [1, 2, 3, 4, 5]);
    assert.ok(sent.slice(1).every((m) => m.data.overdue === true && m.data.repeat === true));
    const repeats = await eventsOf(rem.id, "repeat_sent");
    assert.deepEqual(repeats.map((e: any) => e.detail.day), [101, 102, 103, 104, 105].map((n) => dayOf(n)), "one recorded delivery per overdue day");
    const after = await reminderOf(t.id);
    assert.equal(after.status, "sent");
    assert.equal(after.attempts, 1, "the first-delivery attempt counter is not touched by daily reminders");
    assert.equal(after.sentAt.getTime(), firstSentAt.getTime(), "sentAt stays the FIRST delivery (it drives escalation)");
  });

  test("no duplicate: running the job again, or several times at once, on the same overdue day sends nothing more", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(120));
    await runReminderJob(runAt(118));
    await runReminderJob(runAt(121));
    assert.equal(mailsTo(W.sm1.id).length, 2);
    await runReminderJob(runAt(121));
    await runReminderJob(runAt(121, 5));
    await Promise.all([runReminderJob(runAt(121, 8)), runReminderJob(runAt(121, 8)), runReminderJob(runAt(121, 8)), runReminderJob(runAt(121, 9))]);
    assert.equal(mailsTo(W.sm1.id).length, 2, "still one first reminder + one for that day");
    assert.equal((await eventsOf((await reminderOf(t.id)).id, "repeat_sent")).length, 1);
    await runReminderJob(runAt(122));
    assert.equal(mailsTo(W.sm1.id).length, 3, "the next day sends again");
  });

  test("a reminder first sent TODAY is not repeated the same day, even when the activity is already overdue", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(130));
    await runReminderJob(runAt(133)); // created for the first time 3 days after the due date
    assert.equal(mailsTo(W.sm1.id).length, 1);
    await runReminderJob(runAt(133, 6));
    assert.equal(mailsTo(W.sm1.id).length, 1, "the first reminder counts as that day's reminder");
    await runReminderJob(runAt(134));
    assert.equal(mailsTo(W.sm1.id).length, 2);
    assert.equal(mailsTo(W.sm1.id)[0].data.overdue, true);
    void t;
  });

  test("stops: acknowledged, resolved, closed and archived tickets get no further daily reminder", async () => {
    await setPolicy(2, null);
    const [ack, resolved, closed, archived, stays] = [
      await makeTicket(W.northCo, dueOn(140)), await makeTicket(W.northCo, dueOn(140)), await makeTicket(W.northCo, dueOn(140)),
      await makeTicket(W.northCo, dueOn(140)), await makeTicket(W.northCo, dueOn(140)),
    ];
    await runReminderJob(runAt(138));
    await runReminderJob(runAt(141));
    const total = () => mailsTo(W.sm1.id).length;
    assert.equal(total(), 10, "five tickets: first + one overdue-day reminder each");
    const remAck = await reminderOf(ack.id);
    assert.equal((await call(W.admin, "POST", `/reminders/${remAck.id}/acknowledge`, {})).status, 200);
    await prisma.complaint.update({ where: { id: resolved.id }, data: { status: "resolved", closedAt: runAt(141) } });
    await prisma.complaint.update({ where: { id: closed.id }, data: { status: "closed", closedAt: runAt(141) } });
    await prisma.complaint.update({ where: { id: archived.id }, data: { archivedAt: runAt(141) } });
    mails = [];
    const out = await runReminderJob(runAt(142));
    assert.equal(mails.length, 1, "only the ticket that is still open and unacknowledged is reminded");
    assert.equal(mails[0].data.activityRef, stays.ticketNumber);
    assert.equal(mails[0].data.daysOverdue, 2);
    assert.ok(out.closed >= 3, "the resolved, closed and archived tickets' reminders are closed");
    for (const t of [resolved, closed, archived]) assert.equal((await reminderOf(t.id)).status, "closed");
    assert.equal((await reminderOf(ack.id)).status, "acknowledged");
    mails = [];
    await runReminderJob(runAt(143));
    assert.equal(mails.length, 1, "and it stays that way on later days");
  });

  test("a due date moved into the future stops the daily reminders; a later overdue day resumes them", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(150));
    await runReminderJob(runAt(148));
    await runReminderJob(runAt(151));
    assert.equal(mailsTo(W.sm1.id).length, 2);
    await prisma.complaint.update({ where: { id: t.id }, data: { dueDate: dueOn(160) } });
    await runReminderJob(runAt(152));
    await runReminderJob(runAt(153));
    assert.equal(mailsTo(W.sm1.id).length, 2, "the new due date is in the future: no overdue reminder");
    await runReminderJob(runAt(161));
    assert.equal(mailsTo(W.sm1.id).length, 3, "overdue against the NEW due date: the daily reminder resumes");
    assert.equal(mailsTo(W.sm1.id)[2].data.daysOverdue, 1);
  });

  test("a failed daily delivery is retried the same day for the recipient that failed only, never twice for one that got it, and tried again the next day", async () => {
    await setPolicy(2, null);
    await prisma.regionManager.create({ data: { regionId: W.north.id, userId: W.sm2.id } });
    try {
      const t = await makeTicket(W.northCo, dueOn(170));
      await runReminderJob(runAt(168)); // both managers get the first reminder
      assert.equal(mailsTo(W.sm1.id).length + mailsTo(W.sm2.id).length, 2);
      emailFail.add(W.sm2.id);
      const first = await runReminderJob(runAt(171));
      assert.equal(first.repeatRetryPending, 1);
      assert.equal(mailsTo(W.sm1.id).length, 2, "sm1 got the day's reminder");
      assert.equal(mailsTo(W.sm2.id).length, 1, "sm2 did not");
      assert.equal((await eventsOf((await reminderOf(t.id)).id, "repeat_delivery_failed")).length >= 1, true, "the failure is recorded");
      emailFail.clear();
      await runReminderJob(runAt(171, 3)); // a later run, same day
      assert.equal(mailsTo(W.sm2.id).length, 2, "sm2 gets it on the retry");
      assert.equal(mailsTo(W.sm1.id).length, 2, "sm1 is NOT sent it a second time");
      await runReminderJob(runAt(171, 6));
      assert.equal(mailsTo(W.sm1.id).length + mailsTo(W.sm2.id).length, 4, "complete for the day: nothing more");
      await runReminderJob(runAt(172));
      assert.equal(mailsTo(W.sm1.id).length + mailsTo(W.sm2.id).length, 6, "next day, both again");
    } finally {
      await prisma.regionManager.deleteMany({ where: { regionId: W.north.id, userId: W.sm2.id } });
    }
  });

  test("a recipient that keeps failing is attempted at most 5 times a day, and tried again the next day", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(180));
    await runReminderJob(runAt(178));
    emailFail.add(W.sm1.id);
    for (let i = 0; i < 9; i++) await runReminderJob(runAt(181, i));
    const rem = await reminderOf(t.id);
    const failedToday = (await eventsOf(rem.id, "repeat_delivery_failed")).filter((e: any) => e.detail.day === dayOf(181) && e.channel === "email");
    assert.equal(failedToday.length, 5, "capped at the existing delivery-attempt limit per day");
    emailFail.clear();
    await runReminderJob(runAt(182));
    assert.equal(mailsTo(W.sm1.id).length, 2, "the next day it is delivered");
  });

  test("no recipient: an overdue activity in a region with nobody mapped is flagged once a day, is never sent to anyone unrelated, and is reminded as soon as a manager is mapped", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.eastCo, dueOn(190));
    for (let n = 188; n <= 193; n++) await runReminderJob(runAt(n)); // first delivery has nobody: retried each run until its 5 attempts are used
    const rem = await reminderOf(t.id);
    assert.equal(rem.status, "no_recipient");
    assert.equal(rem.attempts, 5, "the existing first-delivery retry limit is unchanged");
    assert.equal(mails.length, 0, "nobody was e-mailed");
    const flags = await eventsOf(rem.id, "repeat_no_recipient");
    assert.ok(flags.length >= 1 && new Set(flags.map((e: any) => e.detail.day)).size === flags.length, "at most one 'no recipient today' flag per day");
    await runReminderJob(runAt(194, 2));
    await runReminderJob(runAt(194, 3));
    assert.equal((await eventsOf(rem.id, "repeat_no_recipient")).filter((e: any) => e.detail.day === dayOf(194)).length, 1, "even when run several times that day");
    await prisma.regionManager.create({ data: { regionId: W.east.id, userId: W.sm2.id } });
    try {
      await runReminderJob(runAt(194, 4));
      const got = mailsTo(W.sm2.id);
      assert.equal(got.length, 1, "the newly mapped manager is reminded the same day");
      assert.equal(got[0].data.overdue, true);
      const after = await reminderOf(t.id);
      assert.equal(after.attempts, 5, "attempt counter and status keep the existing rules");
      assert.equal(after.status, "no_recipient");
    } finally {
      await prisma.regionManager.deleteMany({ where: { regionId: W.east.id, userId: W.sm2.id } });
    }
  });

  test("an overdue reminder whose first delivery used up its 5 attempts still gets the daily reminder, and the existing retry rules are unchanged", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(200));
    emailFail.add(W.sm1.id);
    for (let n = 198; n <= 203; n++) await runReminderJob(runAt(n)); // 5 failed first-delivery attempts, then nothing more from the old path
    let rem = await reminderOf(t.id);
    assert.equal(rem.status, "failed");
    assert.equal(rem.attempts, 5);
    assert.equal(mails.length, 0);
    emailFail.clear();
    await runReminderJob(runAt(204));
    assert.equal(mailsTo(W.sm1.id).length, 1, "the manager finally gets the overdue reminder");
    rem = await reminderOf(t.id);
    assert.equal(rem.attempts, 5, "attempts untouched");
    assert.equal(rem.status, "failed", "status untouched: only the existing path changes it");
  });

  test("escalation is unchanged by the daily reminders: Regional Manager after the configured hours, Management after the same again, once each, and the daily reminders keep going to the Service Manager only", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(210));
    await runReminderJob(runAt(208)); // first reminder delivered at 04:00 two days before
    for (const n of [209, 210]) await runReminderJob(runAt(n, 1));
    let rem = await reminderOf(t.id);
    assert.equal(rem.escalationLevel, 1, "48 h after the first delivery (the due day) the Regional Manager is told");
    assert.equal(mailsTo(W.rm.id, "service_reminder_escalated").length, 1);
    for (const n of [211, 212]) await runReminderJob(runAt(n, 1));
    rem = await reminderOf(t.id);
    assert.equal(rem.escalationLevel, 2, "48 h after that, Management");
    assert.ok(mails.some((m) => m.to === W.mgmt.id && m.template === "service_reminder_escalated"));
    for (const n of [213, 214, 215]) await runReminderJob(runAt(n, 1));
    rem = await reminderOf(t.id);
    assert.equal(rem.escalationLevel, 2, "never beyond level 2");
    assert.equal(mailsTo(W.rm.id, "service_reminder_escalated").length, 1, "each level once");
    assert.equal(mailsTo(W.rm.id).length, 0, "the Regional Manager is not sent the daily Service Manager reminder");
    const daily = mailsTo(W.sm1.id);
    assert.equal(daily.length, 1 + 5, "first reminder + one per overdue day (D+1 .. D+5)");
    assert.equal(rem.sentAt.getTime(), runAt(208).getTime(), "sentAt is still the first delivery");
  });

  test("an acknowledged reminder stops BOTH the daily reminders and the escalation; policy off sends nothing", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(220));
    await runReminderJob(runAt(218));
    await runReminderJob(runAt(221));
    const rem = await reminderOf(t.id);
    assert.equal((await call(W.admin, "POST", `/reminders/${rem.id}/acknowledge`, {})).status, 200);
    mails = [];
    for (const n of [222, 223, 224, 225]) await runReminderJob(runAt(n, 1));
    assert.equal(mails.length, 0, "no daily reminder and no escalation after acknowledgement");
    await setPolicy(null, null);
    const t2 = await makeTicket(W.northCo, dueOn(230));
    await runReminderJob(runAt(232));
    assert.equal(await reminderOf(t2.id), null);
    assert.equal(mails.length, 0, "with the policy off nothing is created or sent");
  });
});
