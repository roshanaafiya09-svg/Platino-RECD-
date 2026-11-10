/**
 * Real-database tests for the APPROVED R6 reminder and escalation policy:
 *
 *   SCHEDULE   first reminder 2 days before the due date -> another on the due date -> one every day after it, until the ticket is resolved /
 *              closed / archived (or the reminder is acknowledged); never twice in a day, however often (or concurrently) the job runs.
 *   ESCALATION once, 48 hours after the DUE DATE (not after the first delivery), to the responsible Regional Managers of the ticket's site region
 *              (Management when the region has none); it only notifies - the ticket itself is never touched.
 *   RECIPIENTS reminders: the ticket's assigned engineer + the region's active Regional Managers + the region's active Service Managers.
 *
 * Time is simulated: every job run is given an explicit "now". The e-mail provider is replaced by a stub that records what it was asked to send
 * (nothing leaves this process); WhatsApp / SMS are stubs.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; removed in `after`). The company-settings
 * singleton row is changed for the run and restored; the seeded Management / Owner users are only ever deactivated for one test and put back.
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
  : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";

describe("approved R6 reminder and escalation policy against the real test database", { skip }, () => {
  const PREFIX = `ZP${Date.now().toString(36).toUpperCase()}`;
  const DAY = 24 * 3600 * 1000;
  const HOUR = 3600 * 1000;
  const T0 = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  /** A simulated job run: `n` days from today at 04:00 UTC (the hour the cron runs), plus optional extra hours. */
  const runAt = (n: number, extraHours = 0) => new Date(T0.getTime() + n * DAY + (4 + extraHours) * HOUR);
  /** A due date is a calendar day, stored as UTC midnight. */
  const dueOn = (n: number) => new Date(T0.getTime() + n * DAY);
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

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, email: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
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
  async function makeTicket(w: any, dueDate: Date | null, opts: { status?: string; assignedToId?: string | null } = {}) {
    const unit = await w.newUnit();
    const t = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.customer.id, siteId: w.site.id, unitId: unit.id, category: "non_performance", description: `${PREFIX} ticket`, severity: "medium", status: opts.status ?? "open", dueDate, assignedToId: opts.assignedToId ?? null } });
    tracked.complaintIds.add(t.id);
    return t;
  }
  const setPolicy = (lead: number | null, hours: number | null) =>
    prisma.companySettings.upsert({ where: { id: "singleton" }, update: { reminderLeadDays: lead, reminderEscalationHours: hours }, create: { id: "singleton", reminderLeadDays: lead, reminderEscalationHours: hours } });
  const reminderOf = (complaintId: string) => prisma.serviceReminder.findUnique({ where: { complaintId } });
  const eventsOf = async (reminderId: string, type: string) => prisma.serviceReminderEvent.findMany({ where: { reminderId, type }, orderBy: { createdAt: "asc" } });
  /** E-mails of one template to one user. */
  const got = (userId: string, template = "service_reminder") => mails.filter((m) => m.to === userId && m.template === template);
  /** E-mails of one template about one ticket (by reference). */
  const aboutTicket = (ticketNumber: string, template: string) => mails.filter((m) => m.template === template && m.data.activityRef === ticketNumber);
  const recipientsOf = (ticketNumber: string, template: string) => [...new Set(aboutTicket(ticketNumber, template).map((m) => m.to))].sort();
  const sortedIds = (...users: any[]) => users.map((u) => u.id).sort();
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
    for (const key of ["service_manager", "regional_manager", "management", "owner_admin", "service_engineer"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    W.north = await makeRegion("North"); // sm1, rm1, rm2 (+ rmOff inactive)
    W.east = await makeRegion("East"); // nobody mapped
    W.west = await makeRegion("West"); // only a Service Manager: no Regional Manager
    W.south = await makeRegion("South"); // other region: rmSouth
    W.sm1 = await makeUser("sm1", "service_manager");
    W.sm2 = await makeUser("sm2", "service_manager");
    W.rm1 = await makeUser("rm1", "regional_manager");
    W.rm2 = await makeUser("rm2", "regional_manager");
    W.rmOff = await makeUser("rm-off", "regional_manager", { isActive: false });
    W.rmSouth = await makeUser("rm-south", "regional_manager");
    W.mgmt = await makeUser("mgmt", "management");
    W.eng = await makeUser("eng", "service_engineer");
    W.engOff = await makeUser("eng-off", "service_engineer", { isActive: false });
    await prisma.regionManager.createMany({
      data: [
        { regionId: W.north.id, userId: W.sm1.id }, { regionId: W.north.id, userId: W.rm1.id }, { regionId: W.north.id, userId: W.rm2.id }, { regionId: W.north.id, userId: W.rmOff.id },
        { regionId: W.west.id, userId: W.sm2.id }, { regionId: W.south.id, userId: W.rmSouth.id },
      ],
    });
    W.northCo = await makeCustomer("N", W.north);
    W.eastCo = await makeCustomer("E", W.east);
    W.westCo = await makeCustomer("W", W.west);
    W.noRegionCo = await makeCustomer("X", null);
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
  // SCHEDULE
  // ------------------------------------------------------------------------------------------

  test("schedule: first reminder 2 days before the due date, another ON the due date, then one every day after it (none on the days in between)", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(100), { assignedToId: W.eng.id });
    await runReminderJob(runAt(97)); // 3 days before
    assert.equal(mails.length, 0, "nothing 3 days before the due date");
    await runReminderJob(runAt(98)); // 2 days before
    assert.equal(got(W.sm1.id).length, 1, "first reminder 2 days before");
    assert.equal(got(W.sm1.id)[0].data.dueToday, undefined);
    assert.equal(got(W.sm1.id)[0].data.overdue, false);
    await runReminderJob(runAt(99)); // the day before: nothing
    assert.equal(got(W.sm1.id).length, 1, "nothing on the day before the due date");
    await runReminderJob(runAt(100)); // the due date
    assert.equal(got(W.sm1.id).length, 2, "another reminder on the due date");
    assert.equal(got(W.sm1.id)[1].data.dueToday, true);
    assert.equal(got(W.sm1.id)[1].data.overdue, false, "not overdue yet on the due date itself");
    for (const n of [101, 102, 103]) await runReminderJob(runAt(n));
    const mine = got(W.sm1.id);
    assert.equal(mine.length, 5, "first + due date + 3 overdue days");
    assert.deepEqual(mine.slice(2).map((m) => m.data.daysOverdue), [1, 2, 3]);
    assert.ok(mine.slice(2).every((m) => m.data.overdue === true));
    const rem = await reminderOf(t.id);
    assert.deepEqual((await eventsOf(rem.id, "repeat_sent")).filter((e: any) => e.recipientId === W.sm1.id).map((e: any) => e.detail.day), [100, 101, 102, 103].map((n) => dayOf(n)), "one recorded delivery per day, starting on the due date");
  });

  test("schedule: a reminder first created on or after the due date counts as that day's reminder and is not repeated the same day", async () => {
    await setPolicy(2, null);
    await makeTicket(W.northCo, dueOn(110));
    await runReminderJob(runAt(110)); // created and sent on the due date itself
    assert.equal(got(W.sm1.id).length, 1);
    await runReminderJob(runAt(110, 6));
    assert.equal(got(W.sm1.id).length, 1, "not twice on the due date");
    await runReminderJob(runAt(111));
    assert.equal(got(W.sm1.id).length, 2);
  });

  test("schedule: a ticket with no due date, or whose due date is further away than the lead time, is not reminded", async () => {
    await setPolicy(2, 48);
    await makeTicket(W.northCo, null);
    await makeTicket(W.northCo, dueOn(125));
    await runReminderJob(runAt(120)); // 5 days before the second one
    assert.equal(mails.length, 0);
  });

  test("schedule: policy off (no lead time) sends nothing; no escalation hours means reminders still go out but nothing escalates", async () => {
    await setPolicy(null, null);
    const t1 = await makeTicket(W.northCo, dueOn(130));
    await runReminderJob(runAt(131));
    assert.equal(await reminderOf(t1.id), null);
    assert.equal(mails.length, 0, "policy off: nothing created or sent");
    await setPolicy(2, null);
    await runReminderJob(runAt(135));
    assert.ok(got(W.sm1.id).length >= 1, "reminders resume with a lead time");
    await runReminderJob(runAt(140));
    assert.equal(mails.filter((m) => m.template === "service_reminder_escalated").length, 0, "no escalation hours: nothing escalates, however overdue");
  });

  // ------------------------------------------------------------------------------------------
  // RECIPIENTS
  // ------------------------------------------------------------------------------------------

  test("recipients: the assigned engineer, the region's Regional Managers and the region's Service Managers - active ones only, nobody from other regions or other roles", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(150), { assignedToId: W.eng.id });
    await runReminderJob(runAt(148));
    assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder"), sortedIds(W.eng, W.rm1, W.rm2, W.sm1), "engineer + both Regional Managers + the Service Manager");
    assert.equal(got(W.rmOff.id).length, 0, "an inactive manager is not told");
    assert.equal(got(W.rmSouth.id).length, 0, "a manager of another region is not told");
    assert.equal(got(W.mgmt.id).length, 0, "Management is not a reminder recipient");
    assert.equal(got(W.sm2.id).length, 0, "a Service Manager of another region is not told");
    // the same people on the due date and on an overdue day
    await runReminderJob(runAt(150));
    await runReminderJob(runAt(151));
    for (const u of [W.eng, W.rm1, W.rm2, W.sm1]) assert.equal(got(u.id).length, 3, `${u.name}: first + due date + 1 overdue day`);
  });

  test("recipients: an unassigned ticket reaches the region's managers only; an inactive assignee is skipped", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(160));
    const tInactive = await makeTicket(W.northCo, dueOn(160), { assignedToId: W.engOff.id });
    await runReminderJob(runAt(158));
    assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder"), sortedIds(W.rm1, W.rm2, W.sm1));
    assert.deepEqual(recipientsOf(tInactive.ticketNumber, "service_reminder"), sortedIds(W.rm1, W.rm2, W.sm1), "the inactive engineer is not told");
    assert.equal(got(W.engOff.id).length, 0);
  });

  test("recipients: a region with only a Service Manager reaches that manager; a ticket whose site has no region reaches its assignee only", async () => {
    await setPolicy(2, null);
    const tWest = await makeTicket(W.westCo, dueOn(165));
    const tNoRegion = await makeTicket(W.noRegionCo, dueOn(165), { assignedToId: W.eng.id });
    await runReminderJob(runAt(163));
    assert.deepEqual(recipientsOf(tWest.ticketNumber, "service_reminder"), sortedIds(W.sm2));
    assert.deepEqual(recipientsOf(tNoRegion.ticketNumber, "service_reminder"), sortedIds(W.eng), "no region: the engineer assigned to the ticket still hears about it");
  });

  test("recipients: nobody at all (no region manager, no assignee) is recorded as 'no recipient' - flagged, retried, and never sent to anyone unrelated", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.eastCo, dueOn(170));
    const tNoRegion = await makeTicket(W.noRegionCo, dueOn(170));
    await runReminderJob(runAt(168));
    assert.equal(mails.length, 0, "nobody was e-mailed");
    assert.equal((await reminderOf(t.id)).status, "no_recipient");
    assert.equal((await reminderOf(t.id)).statusReason, "no_active_manager");
    assert.equal((await reminderOf(tNoRegion.id)).statusReason, "no_region");
    // as soon as a manager is mapped, the next run delivers it
    await prisma.regionManager.create({ data: { regionId: W.east.id, userId: W.sm2.id } });
    try {
      await runReminderJob(runAt(169));
      assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder"), sortedIds(W.sm2));
      assert.equal((await reminderOf(t.id)).status, "sent");
    } finally {
      await prisma.regionManager.deleteMany({ where: { regionId: W.east.id, userId: W.sm2.id } });
    }
  });

  // ------------------------------------------------------------------------------------------
  // STOP CONDITIONS
  // ------------------------------------------------------------------------------------------

  test("stops: resolved, closed, archived and acknowledged tickets get no further reminder and are never escalated", async () => {
    await setPolicy(2, 48);
    const [ack, resolved, closed, archived, stays] = [
      await makeTicket(W.northCo, dueOn(180)), await makeTicket(W.northCo, dueOn(180)), await makeTicket(W.northCo, dueOn(180)),
      await makeTicket(W.northCo, dueOn(180)), await makeTicket(W.northCo, dueOn(180)),
    ];
    await runReminderJob(runAt(178));
    await runReminderJob(runAt(180)); // the due date: a reminder for all five
    assert.equal(got(W.sm1.id).length, 10, "five tickets: first + due-date reminder each");
    const remAck = await reminderOf(ack.id);
    assert.equal((await call(W.admin, "POST", `/reminders/${remAck.id}/acknowledge`, {})).status, 200);
    await prisma.complaint.update({ where: { id: resolved.id }, data: { status: "resolved", closedAt: runAt(180) } });
    await prisma.complaint.update({ where: { id: closed.id }, data: { status: "closed", closedAt: runAt(180) } });
    await prisma.complaint.update({ where: { id: archived.id }, data: { archivedAt: runAt(180) } });
    mails = [];
    const out = await runReminderJob(runAt(181));
    assert.equal(aboutTicket(stays.ticketNumber, "service_reminder").length > 0, true, "the open, unacknowledged ticket is still reminded");
    for (const t of [ack, resolved, closed, archived]) assert.equal(aboutTicket(t.ticketNumber, "service_reminder").length, 0, `${t.ticketNumber}: no reminder after it stopped`);
    assert.ok(out.closed >= 3, "the resolved, closed and archived tickets' reminders are closed");
    for (const t of [resolved, closed, archived]) assert.equal((await reminderOf(t.id)).status, "closed");
    assert.equal((await reminderOf(ack.id)).status, "acknowledged");
    mails = [];
    for (const n of [182, 183, 184]) await runReminderJob(runAt(n)); // past the 48 hours after the due date
    for (const t of [ack, resolved, closed, archived]) {
      assert.equal(aboutTicket(t.ticketNumber, "service_reminder").length, 0);
      assert.equal(aboutTicket(t.ticketNumber, "service_reminder_escalated").length, 0, `${t.ticketNumber}: never escalated`);
      assert.equal((await reminderOf(t.id)).escalationLevel, 0);
    }
    assert.equal(aboutTicket(stays.ticketNumber, "service_reminder_escalated").length > 0, true, "the one that is still open IS escalated");
  });

  test("stops: a ticket resolved AFTER it was escalated gets no further reminders", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(190));
    await runReminderJob(runAt(188));
    await runReminderJob(runAt(192)); // 48+ hours after the due date: escalated
    assert.equal((await reminderOf(t.id)).escalationLevel, 1);
    await prisma.complaint.update({ where: { id: t.id }, data: { status: "resolved", closedAt: runAt(192) } });
    mails = [];
    for (const n of [193, 194, 195]) await runReminderJob(runAt(n));
    assert.equal(mails.length, 0, "resolved: nothing more of any kind");
  });

  test("a due date moved into the future stops the reminders until the new due date; the new due date gets its own due-date reminder", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(200));
    await runReminderJob(runAt(198));
    await runReminderJob(runAt(200));
    assert.equal(got(W.sm1.id).length, 2);
    await prisma.complaint.update({ where: { id: t.id }, data: { dueDate: dueOn(210) } });
    for (const n of [201, 205, 209]) await runReminderJob(runAt(n));
    assert.equal(got(W.sm1.id).length, 2, "the new due date is still in the future: no reminder");
    await runReminderJob(runAt(210));
    assert.equal(got(W.sm1.id).length, 3, "the due-date reminder for the NEW due date");
    assert.equal(got(W.sm1.id)[2].data.dueToday, true);
    await runReminderJob(runAt(211));
    assert.equal(got(W.sm1.id)[3].data.daysOverdue, 1, "counted from the NEW due date");
  });

  // ------------------------------------------------------------------------------------------
  // ESCALATION
  // ------------------------------------------------------------------------------------------

  test("escalation: exactly 48 hours after the DUE DATE - not a minute before - to the region's Regional Managers only, once, and the ticket is untouched", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(220), { assignedToId: W.eng.id, status: "in_progress" });
    const before = await prisma.complaint.findUnique({ where: { id: t.id } });
    await runReminderJob(runAt(218));
    await runReminderJob(new Date(dueOn(222).getTime() - 60_000)); // 47 h 59 min after the due date (00:00 UTC of the due day)
    assert.equal((await reminderOf(t.id)).escalationLevel, 0, "one minute short of 48 hours: not escalated");
    assert.equal(mails.filter((m) => m.template === "service_reminder_escalated").length, 0);
    const out = await runReminderJob(dueOn(222)); // exactly 48 hours after the due date
    assert.equal(out.escalated, 1);
    assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder_escalated"), sortedIds(W.rm1, W.rm2), "the responsible Regional Managers - including those who already got the reminders");
    assert.equal(got(W.sm1.id, "service_reminder_escalated").length, 0, "not the Service Manager");
    assert.equal(got(W.eng.id, "service_reminder_escalated").length, 0, "not the engineer");
    assert.equal(got(W.mgmt.id, "service_reminder_escalated").length, 0, "not Management: the region has Regional Managers");
    assert.equal(got(W.rmOff.id, "service_reminder_escalated").length, 0, "not an inactive manager");
    assert.equal(got(W.rmSouth.id, "service_reminder_escalated").length, 0, "not another region's manager");
    const rem = await reminderOf(t.id);
    assert.equal(rem.escalationLevel, 1);
    assert.equal((await eventsOf(rem.id, "escalated")).length, 1);
    const afterRow = await prisma.complaint.findUnique({ where: { id: t.id } });
    assert.deepEqual(afterRow, before, "escalation notifies only: the ticket (status, assignee, due date, everything) is exactly as it was");
    assert.equal((await prisma.complaintEvent.count({ where: { complaintId: t.id, type: { in: ["status_changed", "closed", "assigned"] } } })), 0, "no ticket history entry was written");
    // the escalation text says what it is
    assert.equal(aboutTicket(t.ticketNumber, "service_reminder_escalated")[0].data.escalationHours, 48);
  });

  test("escalation: the 48 hours count from the due date, not from the time the first reminder was delivered (a reminder delivered late does not delay it)", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(230));
    await runReminderJob(runAt(231)); // the very first reminder is only created and delivered one day AFTER the due date
    assert.equal((await reminderOf(t.id)).sentAt.getTime(), runAt(231).getTime());
    await runReminderJob(new Date(dueOn(232).getTime() - 1));
    assert.equal((await reminderOf(t.id)).escalationLevel, 0);
    await runReminderJob(runAt(232)); // 04:00 on due+2 days: the first run after 48 h from the due date, only ~24 h after the delivery
    assert.equal((await reminderOf(t.id)).escalationLevel, 1, "escalated 48 h after the due date although the reminder was delivered only ~24 h earlier");
    assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder_escalated"), sortedIds(W.rm1, W.rm2));
  });

  test("escalation: once only - repeated and simultaneous runs, and every later day, never escalate (or notify) twice; daily reminders carry on", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(240));
    await runReminderJob(runAt(238));
    // Simultaneous runs share one clock (as they do in reality); a run whose clock is 15+ minutes later may legitimately take over a lease.
    await Promise.all([runReminderJob(runAt(242)), runReminderJob(runAt(242)), runReminderJob(runAt(242)), runReminderJob(runAt(242))]);
    await runReminderJob(runAt(242, 5));
    for (const n of [243, 244, 250]) await runReminderJob(runAt(n));
    assert.equal(aboutTicket(t.ticketNumber, "service_reminder_escalated").length, 2, "exactly one escalation e-mail per Regional Manager (2)");
    const rem = await reminderOf(t.id);
    assert.equal(rem.escalationLevel, 1, "a single escalation level");
    assert.equal((await eventsOf(rem.id, "escalated")).length, 1);
    assert.equal(got(W.sm1.id).length, 5, "the daily reminders kept going: first (day 238) + one for each day the job ran after the due date (242, 243, 244, 250)");
  });

  test("escalation: with no active Regional Manager in the region (none mapped, only a Service Manager, or only an inactive one) it goes to Management instead", async () => {
    await setPolicy(2, 48);
    const east = await makeTicket(W.eastCo, dueOn(250), { assignedToId: W.eng.id }); // nobody mapped; the engineer gets the reminders
    const west = await makeTicket(W.westCo, dueOn(250)); // only a Service Manager
    await prisma.regionManager.create({ data: { regionId: W.east.id, userId: W.rmOff.id } }); // an INACTIVE Regional Manager
    try {
      await runReminderJob(runAt(248));
      await runReminderJob(runAt(252));
      for (const t of [east, west]) {
        const to = recipientsOf(t.ticketNumber, "service_reminder_escalated");
        assert.ok(to.includes(W.mgmt.id), `${t.ticketNumber}: Management is told`);
        assert.ok(!to.includes(W.rmOff.id) && !to.includes(W.sm2.id) && !to.includes(W.eng.id), `${t.ticketNumber}: nobody else`);
      }
    } finally {
      await prisma.regionManager.deleteMany({ where: { regionId: W.east.id, userId: W.rmOff.id } });
    }
  });

  test("escalation: with nobody to tell (no Regional Manager and no active Management) it is recorded and settled - no endless retry, nobody unrelated contacted", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.eastCo, dueOn(260), { assignedToId: W.eng.id });
    const mgmtUsers = await prisma.user.findMany({ where: { isActive: true, role: { key: { in: ["management", "owner_admin"] } } }, select: { id: true } });
    await prisma.user.updateMany({ where: { id: { in: mgmtUsers.map((u: any) => u.id) } }, data: { isActive: false } });
    try {
      await runReminderJob(runAt(258));
      mails = [];
      const out = await runReminderJob(runAt(262));
      assert.equal(out.escalationNoRecipient, 1);
      const rem = await reminderOf(t.id);
      assert.equal(rem.escalationLevel, 1, "settled");
      assert.equal((await eventsOf(rem.id, "escalation_no_recipient")).length, 1);
      assert.equal(mails.filter((m) => m.template === "service_reminder_escalated").length, 0);
      await runReminderJob(runAt(263));
      assert.equal((await eventsOf(rem.id, "escalation_no_recipient")).length, 1, "not repeated");
    } finally {
      await prisma.user.updateMany({ where: { id: { in: mgmtUsers.map((u: any) => u.id) } }, data: { isActive: true } });
    }
  });

  test("escalation: a reminder whose first delivery FAILED is still escalated 48 hours after the due date", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(270), { assignedToId: W.eng.id });
    for (const u of [W.sm1, W.rm1, W.rm2, W.eng]) emailFail.add(u.id);
    await runReminderJob(runAt(268));
    assert.equal((await reminderOf(t.id)).status, "failed");
    emailFail.clear();
    await runReminderJob(runAt(272));
    assert.equal((await reminderOf(t.id)).escalationLevel, 1);
    assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder_escalated"), sortedIds(W.rm1, W.rm2));
  });

  test("escalation: a partly failed delivery keeps the manager who got it, retries only the one who did not, and still ends as exactly one escalation each", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(280));
    await runReminderJob(runAt(278));
    emailFail.add(W.rm2.id);
    const first = await runReminderJob(runAt(282));
    assert.equal(first.escalationRetryPending, 1);
    assert.equal((await reminderOf(t.id)).escalationLevel, 0, "not settled until everybody was told");
    assert.equal(got(W.rm1.id, "service_reminder_escalated").length, 1);
    assert.equal(got(W.rm2.id, "service_reminder_escalated").length, 0);
    emailFail.clear();
    await runReminderJob(runAt(282, 2));
    assert.equal(got(W.rm1.id, "service_reminder_escalated").length, 1, "rm1 is NOT sent it a second time");
    assert.equal(got(W.rm2.id, "service_reminder_escalated").length, 1, "rm2 gets it on the retry");
    assert.equal((await reminderOf(t.id)).escalationLevel, 1);
    await runReminderJob(runAt(283));
    assert.equal(got(W.rm1.id, "service_reminder_escalated").length + got(W.rm2.id, "service_reminder_escalated").length, 2);
  });

  test("escalation: retries stop after the attempt limit (5) when nobody can be reached, and the level stays due", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(290));
    await runReminderJob(runAt(288));
    emailFail.add(W.rm1.id);
    emailFail.add(W.rm2.id);
    for (let i = 0; i < 8; i++) await runReminderJob(runAt(292, i));
    const rem = await reminderOf(t.id);
    assert.equal(rem.escalationLevel, 0, "never settled: nobody was told");
    assert.equal(rem.escalationAttempts, 5, "capped at the delivery-attempt limit");
    assert.equal(got(W.rm1.id, "service_reminder_escalated").length, 0);
  });

  test("escalation: a fresh lease (a run is working on it) keeps other runs out; a stale lease (a dead run) is taken over and the escalation is delivered", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(295));
    await runReminderJob(runAt(293));
    const rem = await reminderOf(t.id);
    const now = runAt(297);
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { escalationClaimedAt: new Date(now.getTime() - 2 * 60_000) } }); // 2 minutes old: fresh
    await runReminderJob(now);
    assert.deepEqual([(await reminderOf(t.id)).escalationLevel, (await reminderOf(t.id)).escalationAttempts], [0, 0], "fresh lease: skipped");
    assert.equal(got(W.rm1.id, "service_reminder_escalated").length, 0);
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { escalationClaimedAt: new Date(now.getTime() - 20 * 60_000) } }); // 20 minutes old: stale
    await runReminderJob(now);
    assert.equal((await reminderOf(t.id)).escalationLevel, 1, "stale lease: taken over and delivered");
    assert.deepEqual(recipientsOf(t.ticketNumber, "service_reminder_escalated"), sortedIds(W.rm1, W.rm2));
  });

  test("escalation: an acknowledged reminder is never escalated and its daily reminders stop too", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(300));
    await runReminderJob(runAt(298));
    await runReminderJob(runAt(300));
    const rem = await reminderOf(t.id);
    assert.equal((await call(W.admin, "POST", `/reminders/${rem.id}/acknowledge`, {})).status, 200);
    mails = [];
    for (const n of [301, 302, 303, 304]) await runReminderJob(runAt(n, 1));
    assert.equal(mails.length, 0, "no daily reminder and no escalation after acknowledgement");
    assert.equal((await reminderOf(t.id)).escalationLevel, 0);
  });

  // ------------------------------------------------------------------------------------------
  // DELIVERY, RETRIES AND DUPLICATES OF THE DAILY REMINDERS
  // ------------------------------------------------------------------------------------------

  test("no duplicates: running the job again, or many times at once, on the due date or any later day sends nothing more", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(310));
    await runReminderJob(runAt(308));
    await runReminderJob(runAt(310));
    await runReminderJob(runAt(310, 5));
    await Promise.all([runReminderJob(runAt(310, 8)), runReminderJob(runAt(310, 8)), runReminderJob(runAt(310, 9))]);
    assert.equal(got(W.sm1.id).length, 2, "first reminder + the due-date reminder, once each");
    await Promise.all([runReminderJob(runAt(311)), runReminderJob(runAt(311)), runReminderJob(runAt(311, 4))]);
    assert.equal(got(W.sm1.id).length, 3, "one for the next day, however many runs");
    assert.equal((await eventsOf((await reminderOf(t.id)).id, "repeat_sent")).filter((e: any) => e.recipientId === W.sm1.id).length, 2);
  });

  test("a failed daily delivery is retried the same day for the recipient that failed only, never twice for one that got it, and capped at 5 attempts a day", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(320));
    await runReminderJob(runAt(318));
    emailFail.add(W.rm2.id);
    const first = await runReminderJob(runAt(320)); // the due date
    assert.equal(first.repeatRetryPending, 1);
    assert.equal(got(W.rm1.id).length, 2, "rm1 got the due-date reminder");
    assert.equal(got(W.rm2.id).length, 1, "rm2 did not");
    emailFail.clear();
    await runReminderJob(runAt(320, 3));
    assert.equal(got(W.rm2.id).length, 2, "rm2 gets it on the retry");
    assert.equal(got(W.rm1.id).length, 2, "rm1 is NOT sent it a second time");
    // a recipient that keeps failing is attempted at most 5 times a day, and again the next day
    emailFail.add(W.rm1.id);
    for (let i = 0; i < 9; i++) await runReminderJob(runAt(321, i));
    const failed = (await eventsOf((await reminderOf(t.id)).id, "repeat_delivery_failed")).filter((e: any) => e.detail.day === dayOf(321) && e.recipientId === W.rm1.id && e.channel === "email");
    assert.equal(failed.length, 5);
    emailFail.clear();
    await runReminderJob(runAt(322));
    assert.equal(got(W.rm1.id).length, 3, "the next day it is delivered");
  });

  test("a reminder whose first delivery used up its 5 attempts still gets the due-date and daily reminders; the first-delivery retry rules are unchanged", async () => {
    await setPolicy(2, null);
    const t = await makeTicket(W.northCo, dueOn(330));
    for (const u of [W.sm1, W.rm1, W.rm2]) emailFail.add(u.id);
    for (let n = 328; n <= 333; n++) await runReminderJob(runAt(n)); // 5 failed first-delivery attempts, then nothing more from that path
    let rem = await reminderOf(t.id);
    assert.equal(rem.status, "failed");
    assert.equal(rem.attempts, 5);
    assert.equal(mails.length, 0);
    emailFail.clear();
    await runReminderJob(runAt(334));
    assert.equal(got(W.sm1.id).length, 1, "the manager finally gets the overdue reminder");
    rem = await reminderOf(t.id);
    assert.equal(rem.attempts, 5, "attempts untouched");
    assert.equal(rem.status, "failed", "status untouched: only the existing path changes it");
  });

  test("every reminder says who, what, where and when: customer, site, serial, reference, due date and a link", async () => {
    await setPolicy(2, 48);
    const t = await makeTicket(W.northCo, dueOn(340));
    await runReminderJob(runAt(338));
    await runReminderJob(runAt(340));
    await runReminderJob(runAt(342));
    const sent = got(W.sm1.id);
    for (const m of sent) {
      assert.equal(m.data.activityRef, t.ticketNumber);
      assert.equal(m.data.customerName, `${PREFIX} N Ltd`);
      assert.equal(m.data.siteName, `${PREFIX} N Plant`);
      assert.match(m.data.serialNo, new RegExp(`^${PREFIX}-N-SN`));
      assert.equal(m.data.dueDate, dueOn(340).toISOString().slice(0, 10));
      assert.match(m.data.link, /\/reminders\?focus=/);
    }
    assert.equal(got(W.rm1.id, "service_reminder_escalated").length, 1);
  });
});
