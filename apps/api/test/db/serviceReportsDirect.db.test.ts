/**
 * Real-database tests for DIRECT service reports (Requirement 4): a visit recorded against a Customer / Site / RECD unit (DG) with no ticket and no
 * AMC order. Covers the migration (the third CHECK shape and the open-report-per-unit index), the foreign keys, the Customer / Site / serial derived
 * from the unit, the permission matrix (roles, regions, vendors), duplicate protection, the mandatory customer signature, the signed PDF, immutability,
 * the audit trail, viewing / downloading, and that the ticket and AMC kinds keep working - through the real routers, real authentication and the real
 * Prisma client.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; everything is removed in `after`). The signature is a
 * generated PNG and all names are synthetic. Nothing is sent anywhere. Run with:
 *   npm run test:db --workspace=apps/api   (database migrated through 20261116090000_direct_service_reports)
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { makePng, pngDataUrl } from "../helpers/png";

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

describe("direct service reports against the real test database", { skip }, () => {
  const PREFIX = `ZD${Date.now().toString(36).toUpperCase()}`;
  const tracked = {
    userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), complaintIds: new Set<string>(),
    unitIds: new Set<string>(), regionIds: new Set<string>(), vendorIds: new Set<string>(), amcIds: new Set<string>(),
  };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let setStorage: (s: any) => void;
  let reportContentHash: (r: any) => string;
  let productId = "";
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const W: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }

  /** A customer with a contact login, one site (in a region, with a vendor), an AMC order and a first unit. More units come from newUnit(). */
  async function makeSide(tag: string, region: any, vendor: any) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag} Industries` } });
    tracked.customerIds.add(customer.id);
    const contact = await makeUser(`${tag} contact`, "customer", { customerId: customer.id });
    const order = await prisma.order.create({
      data: {
        orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 1,
        site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, address: `${tag} Estate`, dgModel: "KG1-250", dgCapacityKva: 250, regionId: region.id, vendorId: vendor.id } },
      },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const side: Record<string, any> = { customer, contact, order, site: order.site };
    side.unit = await newUnit(side, true);
    side.amc = await prisma.amcOrder.create({
      data: { poNo: `${PREFIX}-${tag}-PO`, poDate: new Date("2026-04-01"), customerId: customer.id, location: `${tag} city`, item: "RECD", qty: 1, amcFrequencyPerYear: 4, amcType: "camc", units: { create: [{ unitId: side.unit.id }] } },
    });
    tracked.amcIds.add(side.amc.id);
    return side;
  }

  async function newUnit(side: any, withSerial: boolean, status = "active") {
    const unit = await prisma.recdUnit.create({ data: { serialNo: withSerial ? `${PREFIX}-${side.customer.name.split(" ")[1]}-SN${++seq}` : null, orderId: side.order.id, siteId: side.site.id, productId, status } });
    tracked.unitIds.add(unit.id);
    return unit;
  }

  async function assignTicket(side: any, unit: any, engineer: any, status = "in_progress") {
    const t = await prisma.complaint.create({
      data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: side.customer.id, siteId: side.site.id, unitId: unit.id, category: "non_performance", description: `${PREFIX} ticket`, severity: "medium", status, assignedToId: engineer?.id ?? null },
    });
    tracked.complaintIds.add(t.id);
    return t;
  }

  const tokenOf = (user: any) => signToken({ userId: user.id, roleKey: "x", customerId: user.customerId ?? null });
  async function call(as: any, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { json = null; }
    return { status: res.status, body: json, buf, headers: res.headers };
  }

  const fields = { visitDate: "2026-10-14", workPerformed: "Inspected the RECD and replaced the gasket.", findings: "Minor exhaust leak at the flange.", resolution: "Leak sealed; unit within limits." };
  const createDirect = (as: any, side: any, unit: any, over: Record<string, unknown> = {}) =>
    call(as, "POST", "/service-reports", { customerId: side.customer.id, unitId: unit.id, ...fields, ...over });
  async function awaiting(side: any, unit: any, who: any = W.mgmt) {
    const c = await createDirect(who, side, unit);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const s = await call(who, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: c.body.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body;
  }
  const startSession = (as: any, r: any, over: Record<string, unknown> = {}) =>
    call(as, "POST", `/service-reports/${r.id}/signing-session`, { expectedVersion: r.version, handoffConfirmed: true, ...over });
  const signBody = (r: any, over: Record<string, unknown> = {}) => ({ signerName: "Asha Rao", signatureImage: pngDataUrl(makePng()), version: r.version, confirm: true, ...over });
  /**
   * IN-PERSON signing: the staff member `as` hands the device over (the signing session), then the customer's typed name and drawn signature are submitted
   * from that device. A customer LOGIN is sent straight to the signing route and is refused there. If the hand-over is refused, that answer is returned.
   */
  const sign = async (as: any, r: any, over: Record<string, unknown> = {}) => {
    if (as?.customerId) return call(as, "POST", `/service-reports/${r.id}/sign`, signBody(r, over));
    let signingSession: unknown = over.signingSession;
    if (!("signingSession" in over)) {
      const started = await startSession(as, r);
      if (started.status !== 200) return started;
      signingSession = started.body.signingSession;
    }
    return call(as, "POST", `/service-reports/${r.id}/sign`, signBody(r, { ...over, signingSession }));
  };
  const reportFileCount = () => prisma.reportFile.count();
  const pdfText = async (buf: Buffer) => {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  };
  const pdfImageCount = async (buf: Buffer) => {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try { const img = await parser.getImage(); return img.pages.reduce((n: number, pg: any) => n + pg.images.length, 0); } finally { await parser.destroy(); }
  };
  const rowOf = (id: string) => prisma.serviceReport.findUniqueOrThrow({ where: { id } });
  /** A minimal direct row straight into the table (for the constraint tests). */
  const rawDirect = (side: any, unit: any, over: Record<string, unknown> = {}) =>
    prisma.serviceReport.create({
      data: { reportNumber: `${PREFIX}-RAW${++seq}`, kind: "direct", customerId: side.customer.id, siteId: side.site.id, unitId: unit.id, createdById: W.mgmt.id, visitDate: new Date("2026-10-14"), ...over },
    });

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ setReportStorageForTests: setStorage } = await import("../../src/lib/reportStorage"));
    setStorage(undefined);
    ({ reportContentHash } = await import("../../src/routes/serviceReports"));

    const { serviceReportsRouter } = await import("../../src/routes/serviceReports");
    const { recdUnitsRouter } = await import("../../src/routes/recdUnits");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/service-reports", serviceReportsRouter);
    app.use("/recd-units", recdUnitsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_engineer", "management", "sales", "service_team", "service_manager", "regional_manager"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;

    W.R1 = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-1`, name: `${PREFIX} R1` } });
    W.R2 = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-2`, name: `${PREFIX} R2` } });
    tracked.regionIds.add(W.R1.id).add(W.R2.id);
    for (const n of [1, 2]) {
      W[`V${n}`] = await prisma.vendor.create({ data: { name: `${PREFIX} V${n}`, status: "approved", contactName: "c", contactEmail: `${PREFIX.toLowerCase()}-v${n}@example.test` } });
      tracked.vendorIds.add(W[`V${n}`].id);
    }
    W.mgmt = await makeUser("manager", "management");
    W.team = await makeUser("service team", "service_team");
    W.svcMgr = await makeUser("service manager", "service_manager");
    W.rm1 = await makeUser("regional 1", "regional_manager");
    await prisma.regionManager.create({ data: { regionId: W.R1.id, userId: W.rm1.id } });
    W.vendorUser1 = await makeUser("vendor user 1", "service_team", { vendorId: W.V1.id });
    W.eng = await makeUser("engineer", "service_engineer");
    W.sales = await makeUser("sales", "sales");
    W.A = await makeSide("Alpha", W.R1, W.V1);
    W.B = await makeSide("Beta", W.R2, W.V2);
  });

  after(async () => {
    server?.close();
    setStorage?.(undefined);
    try {
      if (prisma) {
        const customerIds = [...tracked.customerIds];
        const reports = await prisma.serviceReport.findMany({ where: { customerId: { in: customerIds } }, select: { id: true, signatureFileId: true, pdfFileId: true } });
        // The disposable test database only: final reports cannot be deleted (migration 20261101090000), so the guard is switched off for the clean-up of
        // the rows THIS run created, and switched on again straight after.
        await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" DISABLE TRIGGER "ServiceReport_final_no_delete"');
        try {
          await prisma.serviceReport.deleteMany({ where: { id: { in: reports.map((r: any) => r.id) } } }); // their events cascade
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" ENABLE TRIGGER "ServiceReport_final_no_delete"');
        }
        await prisma.reportFile.deleteMany({ where: { id: { in: reports.flatMap((r: any) => [r.signatureFileId, r.pdfFileId]).filter(Boolean) } } });
        await prisma.complaint.deleteMany({ where: { id: { in: [...tracked.complaintIds] } } });
        await prisma.amcOrder.deleteMany({ where: { id: { in: [...tracked.amcIds] } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.regionManager.deleteMany({ where: { userId: { in: [...tracked.userIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
        await prisma.region.deleteMany({ where: { id: { in: [...tracked.regionIds] } } });
        await prisma.vendor.deleteMany({ where: { id: { in: [...tracked.vendorIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // The migration and the table rules
  // ------------------------------------------------------------------------------------------

  test("migration objects: the owner CHECK has the third (direct) shape and a partial unique index guards open direct reports; the ticket and AMC rules are still there", async () => {
    const [chk] = await prisma.$queryRaw`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ServiceReport_kind_owner_check'`;
    for (const shape of ["'ticket'", "'amc'", "'direct'"]) assert.ok(chk.def.includes(shape), shape);
    const idx = await prisma.$queryRaw`select indexname, indexdef from pg_indexes where tablename = 'ServiceReport' and indexname like 'ServiceReport_one_open%' order by indexname`;
    assert.deepEqual(idx.map((i: any) => i.indexname), ["ServiceReport_one_open_per_amc_unit", "ServiceReport_one_open_per_complaint", "ServiceReport_one_open_per_direct_unit"]);
    const direct = idx.find((i: any) => i.indexname === "ServiceReport_one_open_per_direct_unit");
    assert.ok(/UNIQUE/i.test(direct.indexdef) && /direct/.test(direct.indexdef) && /draft/.test(direct.indexdef));
    const checks = await prisma.$queryRaw`select conname from pg_constraint where conrelid = '"ServiceReport"'::regclass and contype = 'c' order by conname`;
    assert.deepEqual(checks.map((c: any) => c.conname), ["ServiceReport_final_states_check", "ServiceReport_kind_owner_check", "ServiceReport_signed_complete_check", "ServiceReport_status_check"]);
    const triggers = await prisma.$queryRaw`select tgname from pg_trigger where tgrelid = '"ServiceReport"'::regclass and not tgisinternal order by tgname`;
    assert.ok(triggers.some((t: any) => t.tgname === "ServiceReport_final_no_delete"), "the immutability triggers are untouched");
  });

  test("direct-report CHECK: neither ticket nor AMC order, but Site, RECD unit and Customer are required; the serial snapshot is optional; a signature is always required", async () => {
    const u = await newUnit(W.A, false);
    const ok = await rawDirect(W.A, u, { unitSerialNo: null });
    assert.deepEqual([ok.kind, ok.complaintId, ok.amcOrderId, ok.unitSerialNo, ok.acknowledgementRequired], ["direct", null, null, null, true]);
    await prisma.serviceReport.delete({ where: { id: ok.id } });

    const u2 = await newUnit(W.A, true);
    const ticket = await assignTicket(W.A, u2, W.eng);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a ticket as well", { complaintId: ticket.id }],
      ["an AMC order as well", { amcOrderId: W.A.amc.id }],
      ["no site", { siteId: null }],
      ["no unit", { unitId: null }],
      ["acknowledgement not required", { acknowledgementRequired: false }],
      ["an unknown kind", { kind: "visit" }],
    ];
    for (const [label, over] of cases) {
      await assert.rejects(rawDirect(W.A, u2, over), /check constraint|ServiceReport_kind_owner_check/i, label);
    }
    // the other two shapes still need their owner
    await assert.rejects(prisma.serviceReport.create({ data: { reportNumber: `${PREFIX}-RAW${++seq}`, kind: "ticket", customerId: W.A.customer.id, createdById: W.mgmt.id, visitDate: new Date("2026-10-14") } }), /check constraint/i, "a ticket report without a ticket");
    await assert.rejects(prisma.serviceReport.create({ data: { reportNumber: `${PREFIX}-RAW${++seq}`, kind: "amc", customerId: W.A.customer.id, createdById: W.mgmt.id, visitDate: new Date("2026-10-14") } }), /check constraint/i, "an AMC report without an AMC order");
  });

  test("foreign keys: a direct report must point at a real customer, site, unit and user; its unit and site cannot be deleted while it exists", async () => {
    const u = await newUnit(W.A, true);
    for (const over of [{ customerId: "nope" }, { siteId: "nope" }, { unitId: "nope" }, { createdById: "nope" }]) {
      await assert.rejects(rawDirect(W.A, u, over), (e: any) => e.code === "P2003", JSON.stringify(over));
    }
    const r = await rawDirect(W.A, u);
    await assert.rejects(prisma.recdUnit.delete({ where: { id: u.id } }), (e: any) => e.code === "P2003", "unit: RESTRICT");
    await assert.rejects(prisma.customer.delete({ where: { id: W.A.customer.id } }), (e: any) => e.code === "P2003", "customer: RESTRICT");
    await prisma.serviceReport.delete({ where: { id: r.id } }); // a draft can still be removed
  });

  test("one open direct report per unit (partial unique index); other units and finished reports are independent; ticket and AMC indexes are unaffected", async () => {
    const u = await newUnit(W.A, true);
    const other = await newUnit(W.A, true);
    const first = await rawDirect(W.A, u);
    await assert.rejects(rawDirect(W.A, u), (e: any) => e.code === "P2002", "a second open report for the same unit");
    await prisma.serviceReport.update({ where: { id: first.id }, data: { status: "awaiting_signature" } });
    await assert.rejects(rawDirect(W.A, u), (e: any) => e.code === "P2002", "awaiting a signature is still open");
    assert.ok(await rawDirect(W.A, other), "another unit is independent");
    // an open ticket report and an open AMC report on the SAME unit are different kinds and do not collide with it
    const ticket = await assignTicket(W.A, u, W.eng);
    await prisma.serviceReport.create({ data: { reportNumber: `${PREFIX}-T${++seq}`, kind: "ticket", complaintId: ticket.id, customerId: W.A.customer.id, siteId: W.A.site.id, unitId: u.id, createdById: W.mgmt.id, visitDate: new Date("2026-10-14") } });
    await prisma.amcOrderUnit.create({ data: { amcOrderId: W.A.amc.id, unitId: u.id } });
    await prisma.serviceReport.create({ data: { reportNumber: `${PREFIX}-A${++seq}`, kind: "amc", amcOrderId: W.A.amc.id, unitSerialNo: u.serialNo, customerId: W.A.customer.id, siteId: W.A.site.id, unitId: u.id, createdById: W.mgmt.id, visitDate: new Date("2026-10-14") } });
  });

  // ------------------------------------------------------------------------------------------
  // Creating: derived relationships
  // ------------------------------------------------------------------------------------------

  test("create: Customer, Site, unit and serial are DERIVED from the unit - ids in the body cannot redirect them; no ticket or AMC order is involved", async () => {
    const u = await newUnit(W.A, true);
    const r = await call(W.mgmt, "POST", "/service-reports", {
      unitId: u.id, ...fields,
      siteId: W.B.site.id, kind: "ticket", status: "signed", unitSerialNo: "FAKE", createdById: W.eng.id, complaintId: undefined, amcOrderId: undefined,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = await rowOf(r.body.id);
    assert.deepEqual([row.kind, row.customerId, row.siteId, row.unitId, row.unitSerialNo, row.status, row.complaintId, row.amcOrderId, row.createdById, row.acknowledgementRequired],
      ["direct", W.A.customer.id, W.A.site.id, u.id, u.serialNo, "draft", null, null, W.mgmt.id, true]);
    assert.match(row.reportNumber, /^DSR-[0-9A-Z]{8}-R1$/);
    assert.deepEqual([r.body.kind, r.body.customerId, r.body.siteId, r.body.unitId, r.body.ticketNumber, r.body.amc], ["direct", W.A.customer.id, W.A.site.id, u.id, null, null]);
    const events = await prisma.serviceReportEvent.findMany({ where: { reportId: row.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e: any) => [e.type, e.actorId]), [["service_report_created", W.mgmt.id]]);
    assert.equal(events[0].detail.unitId, u.id);
  });

  test("create: a customer that does not own the unit is refused (no mismatched Customer / Site / DG); unknown, retired and site-less units are refused", async () => {
    const u = await newUnit(W.A, true);
    const mismatch = await createDirect(W.mgmt, W.B, u); // customer B + unit of customer A
    assert.deepEqual([mismatch.status, mismatch.body.code], [400, "CUSTOMER_UNIT_MISMATCH"]);
    assert.equal((await call(W.mgmt, "POST", "/service-reports", { unitId: "nope", ...fields })).status, 404);
    const retired = await newUnit(W.A, true, "retired");
    assert.deepEqual([(await createDirect(W.mgmt, W.A, retired)).status, (await createDirect(W.mgmt, W.A, retired)).body.code], [400, "UNIT_RETIRED"]);
    const noSite = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-NOSITE`, orderId: W.A.order.id, siteId: null, productId } });
    tracked.unitIds.add(noSite.id);
    assert.deepEqual([(await createDirect(W.mgmt, W.A, noSite)).status, (await createDirect(W.mgmt, W.A, noSite)).body.code], [400, "UNIT_NO_SITE"]);
    assert.equal((await call(W.mgmt, "POST", "/service-reports", { ...fields })).status, 400, "no unit named");
    assert.equal((await createDirect(W.mgmt, W.A, u, { visitDate: "2999-01-01" })).status, 400, "a future visit date");
    const unsigned = await createDirect(W.mgmt, W.A, u, { acknowledgementRequired: false });
    assert.deepEqual([unsigned.status, unsigned.body.code], [400, "SIGNATURE_REQUIRED"]);
    assert.equal(await prisma.serviceReport.count({ where: { unitId: { in: [u.id, retired.id, noSite.id] } } }), 0, "nothing was saved by any refusal");
  });

  test("create: a unit without a serial number is allowed and the serial reads 'Not recorded'", async () => {
    const u = await newUnit(W.A, false);
    const r = await createDirect(W.mgmt, W.A, u);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await rowOf(r.body.id)).unitSerialNo, null);
    const detail = await call(W.mgmt, "GET", `/service-reports/${r.body.id}`);
    assert.equal(detail.body.unit.serialNo, null);
    const sub = await call(W.mgmt, "POST", `/service-reports/${r.body.id}/submit`, { expectedVersion: 1 });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const signed = await sign(W.mgmt, sub.body);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const pdf = await call(W.A.contact, "GET", `/service-reports/${r.body.id}/pdf`);
    assert.ok((await pdfText(pdf.buf)).includes("RECD serial number: Not recorded"));
  });

  // ------------------------------------------------------------------------------------------
  // Permissions
  // ------------------------------------------------------------------------------------------

  test("who may create: management, service team, service managers and regional managers (in their region); never engineers, sales, customers or anonymous", async () => {
    for (const who of [W.mgmt, W.team, W.svcMgr, W.rm1]) {
      const u = await newUnit(W.A, true);
      assert.equal((await createDirect(who, W.A, u)).status, 201, who.name);
    }
    const u = await newUnit(W.A, true);
    for (const who of [W.eng, W.sales, W.A.contact, W.B.contact]) {
      const r = await createDirect(who, W.A, u);
      assert.equal(r.status, 403, who.name);
      assert.equal((await call(who, "GET", "/service-reports/direct-options")).status, 403, `${who.name}: options`);
    }
    assert.equal(await prisma.serviceReport.count({ where: { unitId: u.id } }), 0);
    assert.equal((await createDirect(null, W.A, u)).status, 401);
    assert.equal((await call(null, "GET", "/service-reports/direct-options")).status, 401);
  });

  test("region and vendor scope: a regional manager only reports on units in their region; a vendor user only on their vendor's sites - on create and on the options list", async () => {
    const a = await newUnit(W.A, true); // region R1, vendor V1
    const b = await newUnit(W.B, true); // region R2, vendor V2
    assert.equal((await createDirect(W.rm1, W.A, a)).status, 201);
    const outsideRegion = await createDirect(W.rm1, W.B, b);
    assert.deepEqual([outsideRegion.status, outsideRegion.body.error], [403, "You cannot create a service report for this site"]);
    const a2 = await newUnit(W.A, true);
    assert.equal((await createDirect(W.vendorUser1, W.A, a2)).status, 201);
    assert.equal((await createDirect(W.vendorUser1, W.B, b)).status, 403, "another vendor's site");
    assert.equal(await prisma.serviceReport.count({ where: { unitId: b.id } }), 0);

    for (const who of [W.rm1, W.vendorUser1]) {
      const customers = (await call(who, "GET", "/service-reports/direct-options")).body.customers.map((c: any) => c.id);
      assert.ok(customers.includes(W.A.customer.id), `${who.name}: sees their own scope`);
      assert.ok(!customers.includes(W.B.customer.id), `${who.name}: does not see the other region / vendor`);
      assert.deepEqual((await call(who, "GET", `/service-reports/direct-options?customerId=${W.B.customer.id}`)).body.units, [], `${who.name}: no units of the other customer`);
    }
    const all = (await call(W.mgmt, "GET", "/service-reports/direct-options")).body.customers.map((c: any) => c.id);
    assert.ok(all.includes(W.A.customer.id) && all.includes(W.B.customer.id), "management sees every customer with an active unit");
  });

  test("options: a customer's active units with their Site (read-only data), serial or null, the open ticket hint and the open direct report", async () => {
    const side = W.A;
    const withSerial = await newUnit(side, true);
    const noSerial = await newUnit(side, false);
    const retired = await newUnit(side, true, "retired");
    const ticketed = await newUnit(side, true);
    const ticket = await assignTicket(side, ticketed, W.eng);
    const closed = await newUnit(side, true);
    await assignTicket(side, closed, W.eng, "closed");
    const inProgress = await newUnit(side, true);
    const draft = (await createDirect(W.mgmt, side, inProgress)).body;
    const res = await call(W.mgmt, "GET", `/service-reports/direct-options?customerId=${side.customer.id}`);
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.body.units.map((u: any) => [u.id, u]));
    assert.ok(byId[withSerial.id] && byId[noSerial.id], "active units are listed");
    assert.equal(byId[retired.id], undefined, "retired units are not");
    assert.equal(byId[noSerial.id].serialNo, null);
    assert.deepEqual([byId[withSerial.id].site.id, byId[withSerial.id].site.name, byId[withSerial.id].site.dgModel], [side.site.id, `${PREFIX} Alpha Plant`, "KG1-250"]);
    assert.deepEqual([byId[ticketed.id].openTicket.id, byId[ticketed.id].openTicket.ticketNumber], [ticket.id, ticket.ticketNumber]);
    assert.equal(byId[closed.id].openTicket, null, "a closed ticket is no suggestion");
    assert.equal(byId[inProgress.id].openDirectReport.id, draft.id);
    assert.equal(byId[withSerial.id].openDirectReport, null);
    // a ticket on the unit is a SUGGESTION only: it never blocks a direct report
    assert.equal((await createDirect(W.mgmt, side, ticketed)).status, 201);
  });

  // ------------------------------------------------------------------------------------------
  // Duplicate protection
  // ------------------------------------------------------------------------------------------

  test("duplicates: a second report for a unit with one in progress is a clear 409; simultaneous creates produce exactly one; a signed report does not block the next visit", async () => {
    const u = await newUnit(W.A, true);
    const first = await createDirect(W.mgmt, W.A, u);
    assert.equal(first.status, 201);
    const again = await createDirect(W.team, W.A, u);
    assert.deepEqual([again.status, again.body.code, again.body.reportId], [409, "REPORT_IN_PROGRESS", first.body.id]);
    await call(W.mgmt, "POST", `/service-reports/${first.body.id}/submit`, { expectedVersion: 1 });
    assert.equal((await createDirect(W.mgmt, W.A, u)).status, 409, "awaiting the customer's signature is still in progress");

    const race = await newUnit(W.A, true);
    const results = await Promise.all(Array.from({ length: 5 }, () => createDirect(W.mgmt, W.A, race)));
    assert.equal(results.filter((x) => x.status === 201).length, 1, results.map((x) => x.status).join());
    assert.ok(results.filter((x) => x.status !== 201).every((x) => x.status === 409));
    assert.equal(await prisma.serviceReport.count({ where: { unitId: race.id, kind: "direct" } }), 1);

    const unit = await newUnit(W.A, true);
    const r1 = await awaiting(W.A, unit);
    assert.equal((await sign(W.mgmt, r1)).status, 200);
    const next = await createDirect(W.mgmt, W.A, unit);
    assert.equal(next.status, 201, "a finished report does not block the next visit");
    assert.ok(next.body.reportNumber.endsWith("-R2") && r1.reportNumber.endsWith("-R1"));
    assert.equal((await rowOf(r1.id)).status, "signed", "the earlier report is untouched");
  });

  // ------------------------------------------------------------------------------------------
  // Draft -> submit -> customer signature -> immutable
  // ------------------------------------------------------------------------------------------

  test("workflow: draft edit, incomplete submit refused, submit waits for the customer (no file yet), staff cannot sign, and the draft is hidden from the customer", async () => {
    const u = await newUnit(W.A, true);
    const d = await call(W.mgmt, "POST", "/service-reports", { unitId: u.id, visitDate: "2026-10-14", workPerformed: "serviced" });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const refused = await call(W.mgmt, "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 1 });
    assert.deepEqual([refused.status, refused.body.missing], [400, ["Findings", "Resolution"]]);
    const edit = await call(W.team, "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "Exhaust leak", resolution: "Sealed", partsUsed: "Gasket", remarks: "Revisit in 3 months" });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal((await call(W.mgmt, "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "stale" })).body.code, "STALE_VERSION");
    assert.equal((await call(W.A.contact, "GET", `/service-reports/${d.body.id}`)).status, 404, "a draft is staff-only");
    const files = await reportFileCount();
    const sub = await call(W.mgmt, "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 2 });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.status, "awaiting_signature");
    assert.equal(await reportFileCount(), files, "no PDF and no signature yet");
    const row = await rowOf(d.body.id);
    assert.match(row.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(row.contentHash, reportContentHash(row), "the stored fingerprint is the direct-report formula");
    assert.deepEqual([row.signedAt, row.signatureFileId, row.pdfFileId], [null, null, null]);
    // staff cannot sign for the customer: without the hand-over there is no signature, and a customer login is not the way either
    for (const who of [W.mgmt, W.team, W.svcMgr]) assert.equal((await call(who, "POST", `/service-reports/${d.body.id}/sign`, signBody(sub.body, { signerName: "Staff Member" }))).status, 400, `${who.name}: no hand-over, no signature`);
    const reopen = await call(W.mgmt, "POST", `/service-reports/${d.body.id}/reopen`, { expectedVersion: sub.body.version });
    assert.deepEqual([reopen.status, reopen.body.status, reopen.body.version], [200, "draft", 3]);
    assert.equal((await rowOf(d.body.id)).contentHash, null);
    const events = await prisma.serviceReportEvent.findMany({ where: { reportId: d.body.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e: any) => e.type), ["service_report_created", "service_report_updated", "service_report_submitted", "service_report_reopened"]);
  });

  test("the fingerprint is specific to the report kind: a direct formula never equals the ticket formula for the same content", async () => {
    const row = { reportNumber: "X-R1", complaintId: null, customerId: "c", siteId: "s", unitId: "u", visitDate: new Date("2026-10-14T00:00:00Z"), workPerformed: "w", findings: "f", resolution: "r", partsUsed: null, remarks: null, version: 1, unitSerialNo: null, amcOrderId: null, acknowledgementRequired: true };
    const direct = reportContentHash({ ...row, kind: "direct" });
    assert.match(direct, /^[0-9a-f]{64}$/);
    assert.notEqual(direct, reportContentHash({ ...row, kind: "ticket" }));
    assert.notEqual(direct, reportContentHash({ ...row, kind: "direct", unitSerialNo: "SN-1" }), "the serial snapshot is part of what is approved");
    assert.equal(reportContentHash({ ...row, kind: "direct" }), direct, "stable");
  });

  test("signing: missing, empty, malformed or oversized signatures and a missing confirmation are rejected and store nothing; only the report's own customer can sign", async () => {
    const u = await newUnit(W.A, true);
    const r = await awaiting(W.A, u);
    const before = await reportFileCount();
    const empty = makePng({ ink: false });
    for (const over of [
      { signatureImage: "" }, { signatureImage: "data:image/png;base64,AAAA" }, { signatureImage: "not-an-image" }, { signatureImage: pngDataUrl(empty) },
      { signatureImage: "data:image/png;base64," + "A".repeat(300_000) }, { confirm: false }, { signerName: "" },
    ]) {
      const s = await sign(W.mgmt, r, over as any);
      assert.ok([400].includes(s.status), `${JSON.stringify(over).slice(0, 60)} -> ${s.status}`);
    }
    assert.equal((await call(W.mgmt, "POST", `/service-reports/${r.id}/sign`, { signerName: "Asha Rao", version: r.version, confirm: true })).status, 400, "no signature field");
    assert.equal(await reportFileCount(), before);
    assert.deepEqual([(await rowOf(r.id)).status, (await rowOf(r.id)).signatureFileId], ["awaiting_signature", null]);
    const customerSign = await sign(W.B.contact, r);
    assert.deepEqual([customerSign.status, customerSign.body.code], [403, "IN_PERSON_ONLY"], "a customer login cannot sign");
    assert.equal((await sign(W.eng, r)).status, 403);
    assert.equal((await call(null, "POST", `/service-reports/${r.id}/sign`, {})).status, 401);
    assert.equal((await sign(W.mgmt, r, { version: 99 })).body.code, "STALE_VERSION");
  });

  test("end to end: the customer signs, the signed PDF holds the real signature and the Customer / Site / DG, and the report is permanent", async () => {
    const u = await newUnit(W.A, true);
    const r = await awaiting(W.A, u, W.team);
    const files = await reportFileCount();
    const s = await sign(W.mgmt, r);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(await reportFileCount(), files + 2, "the signature image and the signed PDF");
    const row = await rowOf(r.id);
    assert.deepEqual([row.status, row.signerName, row.signedById, row.signedVersion], ["signed", "Asha Rao", null, r.version]);
    assert.ok(row.signedAt && row.pdfFileId && row.signatureFileId && row.pdfSha256);
    assert.deepEqual([row.complaintId, row.amcOrderId, row.customerId, row.siteId, row.unitId], [null, null, W.A.customer.id, W.A.site.id, u.id]);

    for (const who of [W.A.contact, W.mgmt, W.team, W.svcMgr]) {
      const d = await call(who, "GET", `/service-reports/${r.id}/pdf`);
      assert.equal(d.status, 200, who.name);
      assert.equal(d.headers.get("content-type"), "application/pdf");
      assert.equal(d.headers.get("content-disposition"), `attachment; filename="service-report-${r.reportNumber}.pdf"`);
      const text = await pdfText(d.buf);
      for (const e of ["Direct Service Report", r.reportNumber, `${PREFIX} Alpha Industries`, `${PREFIX} Alpha Plant`, u.serialNo, "KG1-250, 250 kVA", "Inspected the RECD and replaced the gasket.", "Signed by: Asha Rao", "SIGNED - FINAL", "Document integrity: SHA-256", row.contentHash, "2026-10-14"]) {
        assert.ok(text.includes(e), `${who.name}: ${e}`);
      }
      assert.equal(await pdfImageCount(d.buf), 1, "the customer's drawn signature is embedded as an image");
    }
    const sig = await call(W.mgmt, "GET", `/service-reports/${r.id}/signature`);
    assert.equal(sig.headers.get("content-type"), "image/png");
    assert.equal((await call(W.B.contact, "GET", `/service-reports/${r.id}/pdf`)).status, 404, "another customer");
    assert.equal((await call(W.sales, "GET", `/service-reports/${r.id}/pdf`)).status, 403);
    assert.equal((await call(W.eng, "GET", `/service-reports/${r.id}/pdf`)).status, 403, "an engineer with no ticket on the unit");
    assert.equal((await call(null, "GET", `/service-reports/${r.id}/pdf`)).status, 401);
    const events = await prisma.serviceReportEvent.findMany({ where: { reportId: r.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e: any) => e.type), ["service_report_created", "service_report_submitted", "service_report_signing_started", "service_report_signed"]);
    assert.deepEqual([events[2].type, events[3].type, events[3].actorId, events[3].detail.mode, events[3].detail.signerName], ["service_report_signing_started", "service_report_signed", W.mgmt.id, "in_person", "Asha Rao"], "the staff member who operated the device is the actor; the signer is the typed name");

    // immutability: the API and the database both refuse any change, whatever the route
    assert.equal((await call(W.mgmt, "PATCH", `/service-reports/${r.id}`, { expectedVersion: r.version, findings: "Rewrite", siteId: W.B.site.id })).status, 409);
    assert.equal((await call(W.mgmt, "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: r.version })).status, 409);
    assert.equal((await call(W.mgmt, "POST", `/service-reports/${r.id}/submit`, { expectedVersion: r.version })).status, 409);
    assert.equal((await sign(W.mgmt, r)).status, 409, "a second signature");
    for (const change of [{ findings: "Rewrite" }, { unitSerialNo: "FAKE" }, { siteId: W.B.site.id }, { unitId: null }, { kind: "ticket" }, { pdfSha256: "0".repeat(64) }, { status: "draft" }]) {
      await assert.rejects(prisma.serviceReport.update({ where: { id: r.id }, data: change }), /final and cannot be changed|check constraint/i, JSON.stringify(change));
    }
    await assert.rejects(prisma.serviceReport.delete({ where: { id: r.id } }), /final and cannot be deleted/i);
    await assert.rejects(prisma.recdUnit.delete({ where: { id: u.id } }), (e: any) => e.code === "P2003");
    // available after everything around it moves on: the unit is retired and the customer's AMC / tickets are irrelevant
    await prisma.recdUnit.update({ where: { id: u.id }, data: { status: "retired" } });
    assert.equal((await call(W.A.contact, "GET", `/service-reports/${r.id}/pdf`)).status, 200, "still downloadable after the unit is retired");
  });

  // ------------------------------------------------------------------------------------------
  // Viewing: lists, customer portal, unit history, engineers
  // ------------------------------------------------------------------------------------------

  test("viewing: the list, the customer's own list, the unit history and the filters show a direct report only to those allowed to see it", async () => {
    const u = await newUnit(W.A, true);
    const draft = (await createDirect(W.mgmt, W.A, u)).body;
    const sent = await awaiting(W.A, await newUnit(W.A, true));
    const bUnit = await newUnit(W.B, true);
    const bReport = await awaiting(W.B, bUnit);
    const ids = (res: any) => new Set<string>(res.body.reports.map((r: any) => r.id));

    const mgmt = await call(W.mgmt, "GET", `/service-reports?kind=direct&q=${PREFIX}`);
    assert.equal(mgmt.status, 200, JSON.stringify(mgmt.body));
    assert.ok(ids(mgmt).has(draft.id) && ids(mgmt).has(sent.id) && ids(mgmt).has(bReport.id));
    const row = mgmt.body.reports.find((r: any) => r.id === sent.id);
    assert.deepEqual([row.kind, row.customerName, row.siteName, row.ticketNumber, row.amc], ["direct", `${PREFIX} Alpha Industries`, `${PREFIX} Alpha Plant`, null, null]);
    assert.deepEqual(ids(await call(W.mgmt, "GET", `/service-reports?kind=direct&customerId=${W.B.customer.id}`)), new Set([bReport.id]), "customer filter");
    assert.deepEqual(ids(await call(W.mgmt, "GET", `/service-reports?kind=direct&siteId=${W.B.site.id}`)), new Set([bReport.id]), "site filter");
    assert.deepEqual(ids(await call(W.mgmt, "GET", `/service-reports?unitId=${bUnit.id}`)), new Set([bReport.id]), "DG filter");
    assert.ok(!ids(await call(W.mgmt, "GET", `/service-reports?kind=ticket&q=${PREFIX}`)).has(sent.id), "the type filter separates the kinds");

    const rm = await call(W.rm1, "GET", `/service-reports?kind=direct&q=${PREFIX}`);
    assert.ok(ids(rm).has(sent.id) && !ids(rm).has(bReport.id), "a regional manager: their region only");
    const vendor = await call(W.vendorUser1, "GET", `/service-reports?kind=direct&q=${PREFIX}`);
    assert.ok(ids(vendor).has(sent.id) && !ids(vendor).has(bReport.id), "a vendor user: their vendor's sites only");
    assert.equal((await call(W.sales, "GET", "/service-reports")).status, 403);

    assert.equal((await call(W.A.contact, "GET", "/service-reports/mine")).status, 404, "the customer's own list (/mine) is gone");
    assert.equal((await call(W.A.contact, "GET", `/service-reports/${draft.id}`)).status, 404, "no draft for the customer");
    assert.equal((await call(W.A.contact, "GET", `/service-reports/${bReport.id}`)).status, 404);

    // the RECD unit's history lists its direct reports (left draft) for staff and the owning customer only
    const unitOfSent = (await rowOf(sent.id)).unitId;
    const hist = await call(W.mgmt, "GET", `/recd-units/${unitOfSent}/history`);
    assert.equal(hist.status, 200, JSON.stringify(hist.body));
    assert.deepEqual(hist.body.directServiceReports.map((r: any) => r.id), [sent.id]);
    assert.ok(!JSON.stringify(hist.body).includes("pdfFileId"));
    assert.deepEqual((await call(W.A.contact, "GET", `/recd-units/${unitOfSent}/history`)).body.directServiceReports.map((r: any) => r.id), [sent.id]);
    assert.equal((await call(W.B.contact, "GET", `/recd-units/${unitOfSent}/history`)).status, 403);
    assert.deepEqual((await call(W.mgmt, "GET", `/recd-units/${u.id}/history`)).body.directServiceReports, [], "a draft is not in the history");
  });

  test("engineers: they cannot create direct reports, and can only READ one for a unit on which a ticket is assigned to them", async () => {
    const u = await newUnit(W.A, true);
    const r = await awaiting(W.A, u);
    assert.equal((await call(W.eng, "GET", `/service-reports/${r.id}`)).status, 403, "no ticket on the unit");
    assert.equal(new Set((await call(W.eng, "GET", `/service-reports?kind=direct&q=${PREFIX}`)).body.reports.map((x: any) => x.id)).has(r.id), false);
    await assignTicket(W.A, u, W.eng);
    const seen = await call(W.eng, "GET", `/service-reports/${r.id}`);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.deepEqual([seen.body.permissions.canEdit, seen.body.permissions.canSubmit, seen.body.permissions.canReopen, seen.body.permissions.canCollectSignature], [false, false, false, false]);
    assert.equal(new Set((await call(W.eng, "GET", `/service-reports?kind=direct&q=${PREFIX}`)).body.reports.map((x: any) => x.id)).has(r.id), true);
    assert.equal((await call(W.eng, "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: r.version })).status, 403);
    assert.equal((await call(W.eng, "PATCH", `/service-reports/${r.id}`, { expectedVersion: r.version, findings: "x" })).status, 403);
    assert.equal((await sign(W.eng, r)).status, 403);
    const unit2 = await newUnit(W.A, true);
    await assignTicket(W.A, unit2, W.eng);
    assert.equal((await createDirect(W.eng, W.A, unit2)).status, 403, "engineers report through their assigned ticket instead");
  });

  // ------------------------------------------------------------------------------------------
  // The other kinds keep working next to it
  // ------------------------------------------------------------------------------------------

  test("ticket and AMC reports on the same unit still work, and are not blocked by (or blocking) an open direct report", async () => {
    const u = W.A.unit;
    const direct = await createDirect(W.mgmt, W.A, u);
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    const ticket = await assignTicket(W.A, u, W.eng);
    const t = await call(W.mgmt, "POST", "/service-reports", { complaintId: ticket.id, ...fields });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.deepEqual([t.body.kind, t.body.customerId, t.body.siteId, t.body.unitId, t.body.complaintId], ["ticket", W.A.customer.id, W.A.site.id, u.id, ticket.id]);
    const a = await call(W.mgmt, "POST", "/service-reports", { amcOrderId: W.A.amc.id, unitId: u.id, ...fields });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([a.body.kind, a.body.unitSerialNo], ["amc", u.serialNo]);
    assert.equal((await createDirect(W.mgmt, W.A, u)).status, 409, "the direct report is still the open one");
    for (const id of [direct.body.id, t.body.id, a.body.id]) assert.equal((await call(W.mgmt, "GET", `/service-reports/${id}`)).status, 200);
    const all = await call(W.mgmt, "GET", `/service-reports?unitId=${u.id}`);
    assert.deepEqual(new Set(all.body.reports.map((r: any) => r.kind)), new Set(["direct", "ticket", "amc"]));
  });
});

test("the direct-report database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@db.example.supabase.co:5432/postgres"), false);
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5432/platino_test"), false);
  assert.equal(pointsAtIsolatedDb(undefined), false);
});
