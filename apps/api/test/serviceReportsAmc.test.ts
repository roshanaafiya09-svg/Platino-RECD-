// AMC service reports (Requirement 5) through the real router: creation against an AMC order and a covered RECD unit,
// the relationship checks, draft -> submit -> customer signature / or final-without-signature, the signed PDF, access
// control, failures and concurrency. Prisma is replaced by in-memory models and storage by an in-memory provider with
// failure injection; the PDF generator and signature checks are the real ones. Database guarantees (foreign keys, the
// owner CHECK, the unique indexes, the immutability trigger, real atomic claims) are NOT proven here - see
// test/db/serviceReportsAmc.db.test.ts. All names and numbers are synthetic.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import PDFDocument from "pdfkit";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY as P, ROLE_KEY } from "@recd/shared";
import { matchesCondition } from "./helpers/fakeOtpStore";
import { makePng, pngDataUrl } from "./helpers/png";
import { setReportStorageForTests, sha256Hex, type ReportStorage } from "../src/lib/reportStorage";
import { useUserModelForAuth } from "./helpers/authLookupFromUserModel";type Stub = Record<string, (...args: any[]) => any>;
const db: Record<string, Stub> = {};
const stubModel = (model: string, impl: Stub) => { db[model] = impl; };

// ---- people ----------------------------------------------------------------------------------------
interface U { id: string; name: string; role: string; perms: string[]; customerId?: string; vendorId?: string }
const users: Record<string, U> = {
  mgmt: { id: "mgmt", name: "Mia Manager", role: ROLE_KEY.MANAGEMENT, perms: [P.MANAGE_AMC_ORDERS, P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  amcOnly: { id: "amcOnly", name: "Amc Admin", role: ROLE_KEY.OWNER_ADMIN, perms: [P.MANAGE_AMC_ORDERS, P.VIEW_SITE_STATUS] },
  rmService: { id: "rmService", name: "Service Regional Manager", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  engB: { id: "engB", name: "Other Engineer", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS] },
  engA: { id: "engA", name: "Ravi Engineer", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS] },
  serviceMgr: { id: "serviceMgr", name: "Service Manager", role: ROLE_KEY.SERVICE_MANAGER, perms: [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  sales: { id: "sales", name: "Sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS, P.VIEW_SITE_STATUS] },
  vendorUser: { id: "vendorUser", name: "Vendor Staff", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.MANAGE_AMC_ORDERS, P.VIEW_SITE_STATUS], vendorId: "vA" },
  rm: { id: "rm", name: "Regional Manager", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.MANAGE_AMC_ORDERS, P.VIEW_SITE_STATUS] },
  custA: { id: "custA", name: "Asha Rao", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT, P.VIEW_SITE_STATUS], customerId: "cA" },
  custB: { id: "custB", name: "Bala Customer", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT, P.VIEW_SITE_STATUS], customerId: "cB" },
};

// ---- the AMC world -----------------------------------------------------------------------------------
const sites: Record<string, any> = {};
const units: Record<string, any> = {};
/** Tickets assigned to field engineers: an engineer may handle an AMC report only for a unit on which one is assigned to them. */
const assignedTickets: Array<{ assignedToId: string; unitId: string }> = [];
const amcs: Record<string, any> = {};
function resetWorld() {
  for (const t of [sites, units, amcs]) for (const k of Object.keys(t)) delete t[k];
  Object.assign(sites, {
    sA: { id: "sA", companyName: "Acme Plant 1", address: "1 Industrial Estate", dgModel: "KG1-250", dgCapacityKva: 250, regionId: "r1", vendorId: "vA" },
    sA2: { id: "sA2", companyName: "Acme Plant 2", address: "2 Industrial Estate", dgModel: "KG1-500", dgCapacityKva: 500, regionId: "r2", vendorId: "vB" },
    sB: { id: "sB", companyName: "Beta Works", address: "9 Beta Road", dgModel: "KG1-125", dgCapacityKva: 125, regionId: "r1", vendorId: "vA" },
  });
  const unit = (id: string, serialNo: string | null, customerId: string, siteId: string | null, status = "active") => ({
    id, serialNo, status, siteId, order: { customerId }, site: siteId ? { id: siteId, regionId: sites[siteId].regionId, vendorId: sites[siteId].vendorId } : null, product: { name: "RECD", model: "RECD-250" },
  });
  Object.assign(units, {
    uA1: unit("uA1", "SN-A1", "cA", "sA"),
    uA2: unit("uA2", "SN-A2", "cA", "sA2"),
    uARetired: unit("uARetired", "SN-A3", "cA", "sA", "retired"),
    uANoSerial: unit("uANoSerial", null, "cA", "sA"),
    uB1: unit("uB1", "SN-B1", "cB", "sB"),
    uStray: unit("uStray", "SN-X1", "cB", "sB"), // belongs to customer B but (wrongly) listed under customer A's AMC below
  });
  Object.assign(amcs, {
    amc1: { id: "amc1abcdef", customerId: "cA", poNo: "PO-1", poDate: new Date("2026-04-01T00:00:00Z"), amcType: "camc", amcFrequencyPerYear: 4, location: "Coimbatore", customer: { name: "Acme Power Pvt Ltd" }, unitIds: ["uA1", "uA2", "uARetired", "uANoSerial", "uStray"] },
    amc2: { id: "amc2uvwxyz", customerId: "cB", poNo: "PO-2", poDate: new Date("2026-05-01T00:00:00Z"), amcType: "namc", amcFrequencyPerYear: 2, location: "Chennai", customer: { name: "Beta Industries" }, unitIds: ["uB1"] },
  });
}

// ---- the ServiceReport table (AMC-aware) ----------------------------------------------------------
let rows: any[] = [];
let seq = 0;
const reportEvents: any[] = [];
const tick = () => new Promise<void>((r) => setImmediate(r));
const match = (r: any, where: any = {}) => Object.entries(where).every(([k, c]) => matchesCondition(r[k], c));
const OPEN = ["draft", "awaiting_signature"];
const withIncludes = (r: any) => ({
  ...r,
  complaint: null,
  amcOrder: r.amcOrderId ? amcs[Object.keys(amcs).find((k) => amcs[k].id === r.amcOrderId)!] : null,
  site: r.siteId ? { id: r.siteId, regionId: sites[r.siteId].regionId, vendorId: sites[r.siteId].vendorId } : null,
  createdBy: { id: r.createdById, name: users[r.createdById]?.name ?? "?" },
});
const dbFlags = { failUpdateMany: false };
const p2002 = (target: string[]) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName: "ServiceReport", target } });

const serviceReportTable: Stub = {
  async findUnique({ where }: any) { await tick(); const r = rows.find((x) => x.id === where.id); return r ? withIncludes(r) : null; },
  async findUniqueOrThrow({ where }: any) { await tick(); const r = rows.find((x) => x.id === where.id); if (!r) throw new Error("not found"); return withIncludes(r); },
  async findFirst({ where }: any) { await tick(); const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
  async findMany({ where, orderBy }: any) {
    await tick();
    const list = rows.filter((r) => match(r, where));
    list.sort((a, b) => (orderBy?.createdAt === "desc" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
    return list.map(withIncludes);
  },
  async count({ where }: any) { await tick(); return rows.filter((r) => match(r, where)).length; },
  async create({ data }: any) {
    await tick();
    if (rows.some((r) => r.reportNumber === data.reportNumber)) throw p2002(["reportNumber"]);
    if (data.amcOrderId && rows.some((r) => r.amcOrderId === data.amcOrderId && r.unitId === data.unitId && OPEN.includes(r.status))) throw p2002(["amcOrderId", "unitId"]);
    const row = {
      id: `sr${++seq}`, kind: "ticket", complaintId: null, amcOrderId: null, acknowledgementRequired: true, unitSerialNo: null, status: "draft", version: 1,
      partsUsed: null, remarks: null, contentHash: null, submittedAt: null, submittedById: null, signedAt: null, signedVersion: null, signerName: null,
      signedById: null, signatureFileId: null, pdfFileId: null, pdfSha256: null, createdAt: new Date(Date.now() + seq), ...data,
    };
    rows.push(row);
    return withIncludes(row);
  },
  async updateMany({ where, data }: any) {
    await tick();
    if (dbFlags.failUpdateMany) throw new Error("database unavailable");
    const hit = rows.filter((r) => match(r, where));
    for (const r of hit) for (const [k, v] of Object.entries<any>(data)) r[k] = v && typeof v === "object" && !(v instanceof Date) && "increment" in v ? r[k] + v.increment : v;
    return { count: hit.length };
  },
};

// ---- in-memory storage with failure injection ------------------------------------------------------
const files = new Map<string, { bytes: Buffer; contentType: string }>();
const storageFlags = { failPutNumber: 0, puts: 0, corrupt: false, getThrows: false };
let fileSeq = 0;
const memStorage: ReportStorage = {
  name: "memory",
  async put(bytes, contentType) {
    await tick();
    storageFlags.puts++;
    if (storageFlags.failPutNumber && storageFlags.puts === storageFlags.failPutNumber) throw new Error("disk full");
    const ref = `f${++fileSeq}`;
    files.set(ref, { bytes, contentType });
    return { ref, sha256: sha256Hex(bytes), size: bytes.length };
  },
  async get(ref) {
    await tick();
    if (storageFlags.getThrows) throw new Error("storage down");
    const f = files.get(ref);
    if (!f) return null;
    return { bytes: storageFlags.corrupt ? Buffer.concat([f.bytes, Buffer.from("tamper")]) : f.bytes, contentType: f.contentType, sha256: sha256Hex(f.bytes) };
  },
  async delete(ref) { files.delete(ref); },
};

let server: Server;
let base = "";
let tokenFor: (u: string) => string;
const realConsole = { error: console.error, log: console.log };

before(async () => {
  console.error = () => {};
  console.log = () => {};
  const { prisma } = await import("../src/lib/prisma");
  await useUserModelForAuth(prisma);
  const { signToken } = await import("../src/lib/jwt");
  const { serviceReportsRouter } = await import("../src/routes/serviceReports");
  for (const model of ["user", "complaint", "complaintEvent", "serviceReport", "serviceReportEvent", "customer", "site", "recdUnit", "amcOrder", "regionManager"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: users[u].customerId ?? null });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/service-reports", serviceReportsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  setReportStorageForTests(undefined);
  Object.assign(console, realConsole);
});

function reset() {
  rows = [];
  reportEvents.length = 0;
  files.clear();
  seq = 0;
  fileSeq = 0;
  dbFlags.failUpdateMany = false;
  Object.assign(storageFlags, { failPutNumber: 0, puts: 0, corrupt: false, getThrows: false });
  setReportStorageForTests(memStorage);
  resetWorld();
  stubModel("user", {
    findUnique: ({ where }: any) => {
      const u = users[where.id];
      if (!u) return null;
      return { id: u.id, name: u.name, isActive: true, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } };
    },
  });
  assignedTickets.length = 0;
  stubModel("complaint", { findUnique: () => null, findFirst: ({ where }: any) => (assignedTickets.some((t) => t.assignedToId === where.assignedToId && t.unitId === where.unitId) ? { id: "assigned-ticket" } : null) });
  stubModel("complaintEvent", { create: ({ data }: any) => data });
  stubModel("serviceReport", serviceReportTable);
  stubModel("serviceReportEvent", { create: ({ data }: any) => { reportEvents.push(data); return data; } });
  stubModel("customer", { findUnique: ({ where }: any) => ({ name: where.id === "cA" ? "Acme Power Pvt Ltd" : "Beta Industries" }) });
  stubModel("site", { findUnique: ({ where }: any) => sites[where.id] ?? null });
  stubModel("recdUnit", { findUnique: ({ where }: any) => (units[where.id] ? { ...units[where.id] } : null) });
  stubModel("amcOrder", {
    findUnique: ({ where }: any) => {
      const a = Object.values(amcs).find((x: any) => x.id === where.id);
      if (!a) return null;
      return { ...a, units: a.unitIds.map((unitId: string) => ({ unitId, unit: { id: unitId, serialNo: units[unitId].serialNo, status: units[unitId].status, site: units[unitId].siteId ? { companyName: sites[units[unitId].siteId].companyName, address: sites[units[unitId].siteId].address, regionId: sites[units[unitId].siteId].regionId, vendorId: sites[units[unitId].siteId].vendorId } : null } })) };
    },
  });
  stubModel("regionManager", { findMany: () => [{ regionId: "r1" }] });
}

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { json = null; }
  return { status: res.status, body: json, buf, headers: res.headers };
}

const AMC1 = "amc1abcdef";
const AMC2 = "amc2uvwxyz";
const fields = (over: Record<string, unknown> = {}) => ({
  visitDate: "2026-10-14",
  workPerformed: "Quarterly preventive service: cleaned the filter and checked the sensors.",
  findings: "Back-pressure normal; one loose clamp.",
  resolution: "Clamp tightened; unit running within limits.",
  ...over,
});
const createAmc = (as = "mgmt", amcOrderId = AMC1, unitId = "uA1", over: Record<string, unknown> = {}) =>
  call(as, "POST", "/service-reports", { amcOrderId, unitId, ...fields(over) });
const submit = (as: string, r: any) => call(as, "POST", `/service-reports/${r.id}/submit`, { expectedVersion: r.version });
async function awaiting(unitId = "uA1", amcOrderId = AMC1) {
  const c = await createAmc("mgmt", amcOrderId, unitId);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const s = await submit("mgmt", c.body);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body;
}
const goodSignature = () => pngDataUrl(makePng());
const sign = (as: string, r: any, over: Record<string, unknown> = {}) =>
  call(as, "POST", `/service-reports/${r.id}/sign`, { signerName: "Asha Rao", signatureImage: goodSignature(), version: r.version, confirm: true, ...over });
async function signed(unitId = "uA1", amcOrderId = AMC1) {
  const r = await awaiting(unitId, amcOrderId);
  const s = await sign("custA", r);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body;
}
/** An OLDER report that was finalised without a customer signature (that path no longer exists): stored directly, with a PDF that verifies. */
function legacySubmittedNoSignature(unitId = "uA1") {
  const bytes = Buffer.from("%PDF-1.4 older unsigned report");
  const ref = `f${++fileSeq}`;
  files.set(ref, { bytes, contentType: "application/pdf" });
  const row = {
    id: `sr${++seq}`, kind: "amc", complaintId: null, amcOrderId: AMC1, acknowledgementRequired: false, unitSerialNo: units[unitId].serialNo, customerId: "cA", siteId: units[unitId].siteId, unitId,
    createdById: "mgmt", visitDate: new Date("2026-10-14T00:00:00Z"), workPerformed: "serviced", findings: "ok", resolution: "done", partsUsed: null, remarks: null,
    reportNumber: `AMC-ABCDEF-R${seq}`, status: "submitted", version: 1, contentHash: "a".repeat(64), submittedAt: new Date(), submittedById: "mgmt", signedAt: null, signedVersion: null,
    signerName: null, signedById: null, signatureFileId: null, pdfFileId: ref, pdfSha256: sha256Hex(bytes), createdAt: new Date(Date.now() + seq),
  };
  rows.push(row);
  return row;
}
const rowOf = (id: string) => rows.find((r) => r.id === id);
const pdfText = async (buf: Buffer) => {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
};

// =============================================================================================
// Creation and the AMC / customer / site / unit relationships
// =============================================================================================

test("AMC draft: customer, site, unit and the serial are DERIVED from the AMC order and the covered unit - never from the request", async () => {
  reset();
  const r = await call("mgmt", "POST", "/service-reports", {
    amcOrderId: AMC1, unitId: "uA1", ...fields({ partsUsed: "Clamp x1", remarks: "Next visit in January" }),
    customerId: "cB", siteId: "sB", serialNo: "FAKE-SERIAL", unitSerialNo: "FAKE-SERIAL", status: "signed", kind: "ticket", complaintId: undefined, signerName: "Evil",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.kind, "amc");
  assert.equal(r.body.status, "draft");
  assert.equal(r.body.version, 1);
  assert.equal(r.body.reportNumber, "AMC-ABCDEF-R1");
  assert.deepEqual([r.body.customerId, r.body.siteId, r.body.unitId, r.body.unitSerialNo], ["cA", "sA", "uA1", "SN-A1"]);
  assert.equal(r.body.complaintId, null);
  assert.equal(r.body.ticketNumber, null);
  assert.deepEqual([r.body.amc.id, r.body.amc.ref, r.body.amc.poNo], [AMC1, "AMC-ABCDEF", "PO-1"]);
  assert.equal(r.body.acknowledgementRequired, true, "the safe default");
  assert.equal(r.body.signerName, null);
  assert.equal(r.body.pdfAvailable, false);
  const row = rowOf(r.body.id);
  assert.deepEqual([row.kind, row.amcOrderId, row.complaintId, row.customerId, row.siteId, row.unitId, row.unitSerialNo, row.createdById], ["amc", AMC1, null, "cA", "sA", "uA1", "SN-A1", "mgmt"]);
  assert.equal(JSON.stringify(r.body).includes("FAKE-SERIAL"), false);
});

test("AMC draft: the audit trail records who created it, for which AMC, unit and serial", async () => {
  reset();
  await createAmc();
  assert.equal(reportEvents.length, 1);
  const e = reportEvents[0];
  assert.deepEqual([e.type, e.actorId, e.toValue], ["service_report_created", "mgmt", "draft"]);
  assert.deepEqual([e.detail.kind, e.detail.amcOrderId, e.detail.unitId, e.detail.unitSerialNo, e.detail.reportNumber], ["amc", AMC1, "uA1", "SN-A1", "AMC-ABCDEF-R1"]);
});

test("AMC draft: an unknown AMC, a unit the AMC does not cover, a unit of another customer, a retired or serial-less unit are all refused", async () => {
  reset();
  assert.equal((await createAmc("mgmt", "nope", "uA1")).status, 404, "unknown AMC order");
  const notCovered = await createAmc("mgmt", AMC1, "uB1");
  assert.equal(notCovered.status, 400);
  assert.equal(notCovered.body.code, "UNIT_NOT_IN_AMC");
  assert.equal((await createAmc("mgmt", AMC2, "uA1")).body.code, "UNIT_NOT_IN_AMC", "customer A's unit under customer B's AMC");
  assert.equal((await createAmc("mgmt", AMC1, "does-not-exist")).body.code, "UNIT_NOT_IN_AMC");
  const stray = await createAmc("mgmt", AMC1, "uStray"); // linked to the AMC row, but its order belongs to customer B
  assert.equal(stray.status, 400);
  assert.equal(stray.body.code, "UNIT_CUSTOMER_MISMATCH");
  assert.equal((await createAmc("mgmt", AMC1, "uARetired")).body.code, "UNIT_RETIRED");
  assert.equal((await createAmc("mgmt", AMC1, "uANoSerial")).body.code, "UNIT_NO_SERIAL");
  assert.equal(rows.length, 0, "none of the refused requests saved anything");
});

test("AMC draft: validation - unit and AMC required, real visit date, only one owner (ticket OR AMC)", async () => {
  reset();
  assert.equal((await call("mgmt", "POST", "/service-reports", { amcOrderId: AMC1, ...fields() })).status, 400, "no unit");
  assert.equal((await createAmc("mgmt", AMC1, "uA1", { visitDate: "2999-01-01" })).status, 400, "future date");
  assert.equal((await createAmc("mgmt", AMC1, "uA1", { visitDate: "14/10/2026" })).status, 400);
  const unsigned = await createAmc("mgmt", AMC1, "uA1", { acknowledgementRequired: false });
  assert.deepEqual([unsigned.status, unsigned.body.code], [400, "SIGNATURE_REQUIRED"], "an unsigned report cannot be requested");
  const both = await call("mgmt", "POST", "/service-reports", { amcOrderId: AMC1, unitId: "uA1", complaintId: "t1", ...fields() });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /not both/);
  assert.equal(rows.length, 0);
  assert.equal((await call("mgmt", "POST", "/service-reports", { amcOrderId: AMC1, unitId: "uA1", visitDate: "2026-10-14" })).status, 201, "only the visit date is needed for a draft");
});

test("AMC draft: who may create - AMC managers, service staff who manage tickets, and engineers only on a unit they are assigned; vendor and region limits stay", async () => {
  for (const who of ["mgmt", "amcOnly", "serviceMgr"]) { reset(); assert.equal((await createAmc(who)).status, 201, who); }
  reset();
  assert.equal((await createAmc("vendorUser", AMC1, "uA1")).status, 201, "vendor user, unit at their vendor's site");
  reset();
  assert.equal((await createAmc("rm", AMC1, "uA1")).status, 201, "regional manager, unit in their region");
  reset();
  assert.equal((await createAmc("rmService", AMC1, "uA1")).status, 201, "regional manager holding only the service permission, unit in their region");
  for (const [who, unit] of [["vendorUser", "uA2"], ["rm", "uA2"], ["rmService", "uA2"]] as const) {
    reset();
    assert.equal((await createAmc(who, AMC1, unit)).status, 403, `${who} on ${unit} (another vendor / region)`);
    assert.equal(rows.length, 0);
  }
  // A field engineer: only where a ticket on THAT unit is assigned to them.
  reset();
  assert.equal((await createAmc("engA")).status, 403, "engineer with no assigned ticket on the unit");
  assignedTickets.push({ assignedToId: "engA", unitId: "uA2" });
  assert.equal((await createAmc("engA", AMC1, "uA1")).status, 403, "assigned on a different unit");
  assert.equal(rows.length, 0);
  assignedTickets.push({ assignedToId: "engA", unitId: "uA1" });
  const mine = await createAmc("engA", AMC1, "uA1");
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(mine.body.customerId, "cA");
  assert.equal((await createAmc("engB", AMC1, "uA1")).status, 403, "another engineer, ticket not assigned to them");
  for (const who of ["sales", "custA", "custB"]) {
    reset();
    const r = await createAmc(who);
    assert.equal(r.status, 403, who);
    assert.equal(rows.length, 0);
  }
  reset();
  assert.equal((await createAmc(null as any)).status, 401);
});

test("AMC visits: several reports per AMC (one per visit), one in progress per unit, different units in parallel", async () => {
  reset();
  const first = await signed("uA1");
  assert.equal(first.reportNumber, "AMC-ABCDEF-R1");
  const dup = await createAmc("mgmt", AMC1, "uA1");
  assert.equal(dup.status, 201, "the signed visit does not block the next one");
  assert.equal(dup.body.reportNumber, "AMC-ABCDEF-R2");
  const again = await createAmc("mgmt", AMC1, "uA1");
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "REPORT_IN_PROGRESS");
  assert.equal(again.body.reportId, dup.body.id);
  const other = await createAmc("mgmt", AMC1, "uA2");
  assert.equal(other.status, 201, "another unit of the same AMC is independent");
  assert.equal(other.body.reportNumber, "AMC-ABCDEF-R3");
  assert.equal(rows.filter((r) => r.amcOrderId === AMC1).length, 3);
  assert.equal(rows[0].amcOrderId, AMC1);
  assert.equal(JSON.stringify(rowOf(first.id)), JSON.stringify(rows[0]), "the first (signed) visit is untouched");
});

test("AMC visits: the contracted frequency is a schedule, not a limit - no error after more reports than visits per year", async () => {
  reset();
  for (let i = 0; i < 6; i++) {
    const r = await signed("uA1");
    assert.equal(r.status, "signed");
  }
  assert.equal(rows.filter((r) => r.amcOrderId === AMC1).length, 6, "AMC1 contracts 4 visits a year; 6 actual reports are accepted and kept");
});

// =============================================================================================
// Draft editing, the acknowledgement rule, submission
// =============================================================================================

test("AMC edit: a draft can be edited; stale edits are refused; the acknowledgement option no longer exists (ticket or AMC)", async () => {
  reset();
  const d = await createAmc();
  const ok = await call("mgmt", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "Updated findings" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.version, ok.body.acknowledgementRequired, ok.body.findings], [2, true, "Updated findings"]);
  assert.equal((await call("mgmt", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "Overwrite" })).body.code, "STALE_VERSION");
  assert.equal(rowOf(d.body.id).findings, "Updated findings");
  const off = await call("mgmt", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 2, acknowledgementRequired: false });
  assert.deepEqual([off.status, off.body.code], [400, "SIGNATURE_REQUIRED"]);
  assert.equal(rowOf(d.body.id).acknowledgementRequired, true);
  assert.deepEqual(reportEvents.map((e) => e.type), ["service_report_created", "service_report_updated"]);

  rows.push({ id: "tk", kind: "ticket", complaintId: "t1", amcOrderId: null, acknowledgementRequired: true, status: "draft", version: 1, customerId: "cA", siteId: null, unitId: null, createdById: "mgmt", visitDate: new Date("2026-10-14"), workPerformed: "", findings: "", resolution: "", createdAt: new Date() });
  stubModel("serviceReport", { ...serviceReportTable, findUnique: async ({ where }: any) => { const r = rows.find((x) => x.id === where.id); return r ? { ...withIncludes(r), complaint: r.kind === "ticket" ? { id: "t1", ticketNumber: "TCK-1", assignedToId: "mgmt", site: null } : null } : null; } });
  const ticket = await call("mgmt", "PATCH", "/service-reports/tk", { expectedVersion: 1, acknowledgementRequired: false });
  assert.equal(ticket.status, 400, "a ticket report always needs the customer's signature");
});

test("AMC edit and submit: only AMC managers; customers see no draft; incomplete drafts list what is missing", async () => {
  reset();
  const d = await call("mgmt", "POST", "/service-reports", { amcOrderId: AMC1, unitId: "uA1", visitDate: "2026-10-14", workPerformed: "serviced" });
  assert.equal((await call("engA", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "x" })).status, 403);
  assert.equal((await call("custA", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "x" })).status, 404);
  assert.equal((await call("custA", "GET", `/service-reports/${d.body.id}`)).status, 404, "a draft is staff-only");
  const refused = await submit("mgmt", d.body);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.missing, ["Findings", "Resolution"]);
  assert.equal(rowOf(d.body.id).status, "draft");
  assert.equal((await submit("custA", d.body)).status, 404);
  assert.equal((await submit("engA", d.body)).status, 403, "an engineer with no ticket assigned on the unit has no access");
  assert.equal((await submit("sales", d.body)).status, 403);
  const byService = await submit("serviceMgr", d.body);
  assert.equal(byService.status, 400, "a service manager has access; the draft is simply incomplete");
  assert.deepEqual(byService.body.missing, ["Findings", "Resolution"]);
});

test("acknowledgement REQUIRED: submit waits for the customer; reopening bumps the version; the audit trail follows", async () => {
  reset();
  const r = await awaiting();
  assert.equal(r.status, "awaiting_signature");
  assert.match(rowOf(r.id).contentHash, /^[0-9a-f]{64}$/);
  assert.equal(files.size, 0, "no PDF until the customer has signed");
  assert.equal(r.pdfAvailable, false);
  const re = await call("mgmt", "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: r.version });
  assert.deepEqual([re.status, re.body.status, re.body.version], [200, "draft", 2]);
  assert.equal(rowOf(r.id).contentHash, null);
  assert.deepEqual(reportEvents.map((e) => e.type), ["service_report_created", "service_report_submitted", "service_report_reopened"]);
});

// =============================================================================================
// Signing
// =============================================================================================

test("AMC sign: the customer contact signs - signer, time, version, user and files are recorded; the PDF carries AMC details and the signature", async () => {
  reset();
  const r = await awaiting();
  const s = await sign("custA", r, { signerName: "  Asha Rao  " });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.status, s.body.signerName, s.body.signedVersion, s.body.pdfAvailable], ["signed", "Asha Rao", 1, true]);
  const row = rowOf(r.id);
  assert.equal(row.signedById, "custA");
  assert.ok(row.signedAt && row.signatureFileId && row.pdfFileId && row.pdfSha256);
  assert.equal(files.size, 2);
  assert.equal(sha256Hex(files.get(row.pdfFileId)!.bytes), row.pdfSha256);
  assert.ok(files.get(row.signatureFileId)!.bytes.equals(Buffer.from(goodSignature().split(",")[1], "base64")));
  const text = await pdfText(files.get(row.pdfFileId)!.bytes);
  for (const e of ["AMC Service Report", "AMC-ABCDEF-R1", "AMC order: AMC-ABCDEF (PO PO-1, 2026-04-01)", "CAMC (Comprehensive)", "Contracted visits per year: 4", "Acme Power Pvt Ltd", "Acme Plant 1", "SN-A1", "KG1-250", "250 kVA", "Mia Manager", "Signed by: Asha Rao", "SIGNED - FINAL"]) {
    assert.ok(text.includes(e), `PDF should contain ${e}`);
  }
  assert.ok((files.get(row.pdfFileId)!.bytes.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length >= 1, "signature image in the PDF");
  const last = reportEvents[reportEvents.length - 1];
  assert.deepEqual([last.type, last.actorId, last.detail.finalPdfGenerated, last.detail.signerName], ["service_report_signed", "custA", true, "Asha Rao"]);
});

test("AMC sign: the PDF prints the serial recorded when the report was written, even if the unit's serial changes later", async () => {
  reset();
  const r = await awaiting();
  units.uA1.serialNo = "SN-CHANGED-LATER";
  const s = await sign("custA", r);
  assert.equal(s.status, 200);
  const text = await pdfText(files.get(rowOf(r.id).pdfFileId)!.bytes);
  assert.ok(text.includes("SN-A1"));
  assert.ok(!text.includes("SN-CHANGED-LATER"));
  const detail = await call("custA", "GET", `/service-reports/${r.id}`);
  assert.equal(detail.body.unit.serialNo, "SN-A1");
  assert.equal(detail.body.amcDetails.ref, "AMC-ABCDEF");
});

test("AMC sign: missing, empty, malformed or oversized signatures and a missing confirmation are rejected; nothing is stored", async () => {
  reset();
  const r = await awaiting();
  for (const over of [{ signatureImage: undefined }, { signatureImage: "Asha Rao" }, { signatureImage: pngDataUrl(makePng({ ink: false })) }, { signatureImage: "data:image/png;base64,AAAA" }, { confirm: false }, { signerName: "A" }]) {
    assert.equal((await sign("custA", r, over)).status, 400, JSON.stringify(over).slice(0, 60));
  }
  assert.equal(rowOf(r.id).status, "awaiting_signature");
  assert.equal(files.size, 0);
});

test("AMC sign: only the AMC's own customer - not another customer, not staff, not anonymous - and ids in the body change nothing", async () => {
  reset();
  const a = await awaiting("uA1", AMC1);
  const b = await awaiting("uB1", AMC2);
  assert.equal((await sign("custB", a)).status, 404);
  assert.equal((await sign("custA", b)).status, 404);
  for (const who of ["mgmt", "amcOnly", "engA", "rm"]) assert.equal((await sign(who, a)).status, 403, who);
  assert.equal((await call(null, "POST", `/service-reports/${a.id}/sign`, { signerName: "x" })).status, 401);
  const smuggle = await call("custA", "POST", `/service-reports/${a.id}/sign`, { signerName: "Asha Rao", signatureImage: goodSignature(), version: a.version, confirm: true, customerId: "cB", amcOrderId: AMC2, unitId: "uB1", reportId: b.id });
  assert.equal(smuggle.status, 200);
  assert.deepEqual([rowOf(a.id).status, rowOf(b.id).status], ["signed", "awaiting_signature"]);
  assert.deepEqual([rowOf(a.id).amcOrderId, rowOf(a.id).customerId, rowOf(a.id).unitId], [AMC1, "cA", "uA1"]);
});

test("AMC sign: a reopened (edited) report cannot be signed on the old view; a tampered stored report is refused; a second signature is refused", async () => {
  reset();
  const r = await awaiting();
  await call("mgmt", "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: r.version });
  await call("mgmt", "PATCH", `/service-reports/${r.id}`, { expectedVersion: 2, resolution: "Revised resolution" });
  const v3 = await submit("mgmt", { id: r.id, version: 3 });
  assert.equal((await sign("custA", r)).body.code, "STALE_VERSION");
  rowOf(r.id).workPerformed = "Quietly changed";
  assert.equal((await sign("custA", v3.body)).body.code, "REPORT_NOT_SIGNABLE");
  rowOf(r.id).workPerformed = fields().workPerformed;
  assert.equal((await sign("custA", v3.body)).status, 200);
  const again = await sign("custA", v3.body);
  assert.deepEqual([again.status, again.body.code], [409, "ALREADY_SIGNED"]);
  assert.equal(files.size, 2);
});

// =============================================================================================
// Every report needs the customer's signature (the unsigned path is withdrawn)
// =============================================================================================

test("signature required: every submit sends the report to the customer - no PDF is produced and nothing is final until they sign", async () => {
  reset();
  const c = await createAmc("mgmt", AMC1, "uA1");
  assert.equal(c.body.acknowledgementRequired, true);
  const sub = await submit("mgmt", c.body);
  assert.equal(sub.body.status, "awaiting_signature");
  assert.equal(files.size, 0, "no PDF and no signature file before the customer signs");
  assert.equal(rowOf(c.body.id).signedAt, null);
  assert.equal((await call("mgmt", "POST", `/service-reports/${c.body.id}/sign`, { signerName: "Staff Member", signatureImage: goodSignature(), version: sub.body.version, confirm: true })).status, 403, "staff cannot sign for the customer");
  assert.equal(rowOf(c.body.id).status, "awaiting_signature");
  assert.equal((await submit("mgmt", sub.body)).status, 409, "an awaiting report cannot be submitted again");
});

test("signature required: a draft stored under the old option (acknowledgement off) is brought in line on submit and then needs the customer's signature", async () => {
  reset();
  const c = await createAmc("mgmt", AMC1, "uA1");
  rowOf(c.body.id).acknowledgementRequired = false; // as an older draft may have been stored
  const sub = await submit("mgmt", { id: c.body.id, version: c.body.version });
  assert.deepEqual([sub.status, sub.body.status, sub.body.acknowledgementRequired], [200, "awaiting_signature", true]);
  assert.equal(files.size, 0);
  const signedBody = await sign("custA", sub.body);
  assert.equal(signedBody.status, 200, JSON.stringify(signedBody.body));
  assert.equal(signedBody.body.status, "signed");
  assert.equal(files.size, 2, "signature image and signed PDF");
});

test("older unsigned reports: a report finalised without a signature before this change stays viewable and downloadable, and stays final", async () => {
  reset();
  const r = legacySubmittedNoSignature();
  for (const who of ["mgmt", "custA"]) {
    const d = await call(who, "GET", `/service-reports/${r.id}/pdf`);
    assert.equal(d.status, 200, who);
    assert.equal(d.headers.get("content-type"), "application/pdf");
    assert.equal(sha256Hex(d.buf), r.pdfSha256);
  }
  assert.equal((await call("custB", "GET", `/service-reports/${r.id}/pdf`)).status, 404);
  const s = await sign("custA", { id: r.id, version: r.version });
  assert.deepEqual([s.status, s.body.code], [409, "BAD_TRANSITION"], "it can still not be signed afterwards");
  assert.equal((await call("mgmt", "PATCH", `/service-reports/${r.id}`, { expectedVersion: 1, findings: "Rewrite" })).status, 409);
  assert.equal((await call("mgmt", "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: 1 })).status, 409);
  assert.equal((await submit("mgmt", { id: r.id, version: 1 })).status, 409);
  assert.equal((await createAmc()).status, 201, "a finished older report does not block the next visit");
});

// =============================================================================================
// Reading, listing, downloading, access
// =============================================================================================

test("download: staff with AMC access and the owning customer get the PDF; everyone else is refused", async () => {
  reset();
  const s = await signed();
  for (const who of ["mgmt", "amcOnly", "custA"]) assert.equal((await call(who, "GET", `/service-reports/${s.id}/pdf`)).status, 200, who);
  assert.equal((await call("custB", "GET", `/service-reports/${s.id}/pdf`)).status, 404);
  assert.equal((await call("custB", "GET", `/service-reports/${s.id}`)).status, 404);
  assert.equal((await call("custB", "GET", `/service-reports/${s.id}/signature`)).status, 404);
  for (const who of ["engA", "engB", "sales"]) assert.equal((await call(who, "GET", `/service-reports/${s.id}/pdf`)).status, 403, `${who} (no AMC right on this unit)`);
  for (const who of ["serviceMgr", "rmService"]) assert.equal((await call(who, "GET", `/service-reports/${s.id}/pdf`)).status, 200, `${who}: service staff with access to the order`);
  assignedTickets.push({ assignedToId: "engA", unitId: "uA1" });
  assert.equal((await call("engA", "GET", `/service-reports/${s.id}/pdf`)).status, 200, "an engineer with a ticket assigned on that unit");
  assert.equal((await call("engB", "GET", `/service-reports/${s.id}/pdf`)).status, 403, "another engineer");
  assignedTickets.length = 0;
  assert.equal((await call("vendorUser", "GET", `/service-reports/${s.id}/pdf`)).status, 200, "vendor user, their vendor's site");
  const farUnit = await signed("uA2");
  assert.equal((await call("vendorUser", "GET", `/service-reports/${farUnit.id}/pdf`)).status, 403, "vendor user, another vendor's site");
  assert.equal((await call("rm", "GET", `/service-reports/${farUnit.id}/pdf`)).status, 403, "regional manager, another region");
  assert.equal((await call(null, "GET", `/service-reports/${s.id}/pdf`)).status, 401);
  const sig = await call("custA", "GET", `/service-reports/${s.id}/signature`);
  assert.equal(sig.headers.get("content-type"), "image/png");
  assert.equal((await call("mgmt", "GET", `/service-reports/${s.id}/pdf?disposition=inline`)).headers.get("content-disposition")?.startsWith("inline;"), true);
});

test("download: not before finalisation; missing, damaged and unreachable files are reported, never served; storage not configured is a 503", async () => {
  reset();
  const r = await awaiting();
  assert.equal((await call("custA", "GET", `/service-reports/${r.id}/pdf`)).body.code, "NOT_SIGNED");
  assert.equal((await sign("custA", r)).status, 200);
  storageFlags.corrupt = true;
  assert.equal((await call("custA", "GET", `/service-reports/${r.id}/pdf`)).body.code, "FILE_INTEGRITY");
  storageFlags.corrupt = false;
  storageFlags.getThrows = true;
  assert.equal((await call("custA", "GET", `/service-reports/${r.id}/pdf`)).status, 502);
  storageFlags.getThrows = false;
  setReportStorageForTests(null);
  assert.equal((await call("custA", "GET", `/service-reports/${r.id}/pdf`)).status, 503);
  setReportStorageForTests(memStorage);
  files.delete(rowOf(r.id).pdfFileId);
  assert.equal((await call("custA", "GET", `/service-reports/${r.id}/pdf`)).body.code, "FILE_MISSING");
});

test("list by AMC order: context (AMC, units with serials), status of every report, scoping by role; drafts hidden from the customer", async () => {
  reset();
  const signedOne = await signed("uA1");
  const draft = await createAmc("mgmt", AMC1, "uA2");
  const staff = await call("mgmt", "GET", `/service-reports?amcOrderId=${AMC1}`);
  assert.equal(staff.status, 200);
  assert.equal(staff.body.canWrite, true);
  assert.deepEqual(staff.body.reports.map((x: any) => [x.id, x.status]), [[signedOne.id, "signed"], [draft.body.id, "draft"]]);
  assert.deepEqual([staff.body.context.amc.ref, staff.body.context.amc.poNo, staff.body.context.amc.customerName, staff.body.context.amc.visitsPerYear], ["AMC-ABCDEF", "PO-1", "Acme Power Pvt Ltd", 4]);
  assert.ok(staff.body.context.units.some((u: any) => u.id === "uA1" && u.serialNo === "SN-A1"));
  assert.equal(JSON.stringify(staff.body).includes("pdfFileId"), false);
  const byUnit = await call("mgmt", "GET", `/service-reports?amcOrderId=${AMC1}&unitId=uA2`);
  assert.deepEqual(byUnit.body.reports.map((x: any) => x.id), [draft.body.id]);

  const customer = await call("custA", "GET", `/service-reports?amcOrderId=${AMC1}`);
  assert.equal(customer.status, 200);
  assert.equal(customer.body.canWrite, false);
  assert.deepEqual(customer.body.reports.map((x: any) => x.id), [signedOne.id], "no draft for the customer");
  assert.equal((await call("custB", "GET", `/service-reports?amcOrderId=${AMC1}`)).status, 404);
  for (const who of ["engA", "sales", "vendorUser", "rm"]) assert.equal((await call(who, "GET", `/service-reports?amcOrderId=${AMC1}`)).status, 403, who);
  const svc = await call("serviceMgr", "GET", `/service-reports?amcOrderId=${AMC1}`);
  assert.deepEqual([svc.status, svc.body.canWrite, svc.body.reports.length], [200, true, 2], "a service manager sees the order's reports and may write");
  // A regional service user and an engineer see only the units they may handle.
  const rmSvc = await call("rmService", "GET", `/service-reports?amcOrderId=${AMC1}`);
  assert.deepEqual([rmSvc.status, rmSvc.body.reports.map((x: any) => x.unitId)], [200, ["uA1"]], "only the report in their region (uA2 is in another region)");
  assert.ok(!rmSvc.body.context.units.some((u: any) => u.id === "uA2"), "a unit in another region is not offered");
  assignedTickets.push({ assignedToId: "engA", unitId: "uA2" });
  const eng = await call("engA", "GET", `/service-reports?amcOrderId=${AMC1}`);
  assert.deepEqual([eng.status, eng.body.canWrite, eng.body.reports.map((x: any) => x.unitId), eng.body.context.units.map((u: any) => u.id)], [200, true, ["uA2"], ["uA2"]], "only the unit with their assigned ticket");
  assert.equal((await call("mgmt", "GET", `/service-reports?amcOrderId=${AMC1}&complaintId=t1`)).status, 400);
  assert.equal((await call("mgmt", "GET", "/service-reports?amcOrderId=nope")).status, 404);
});

test("customer entry point: /mine lists only the customer's own reports that have left draft", async () => {
  reset();
  const a1 = await awaiting("uA1", AMC1);
  await createAmc("mgmt", AMC1, "uA2"); // a draft
  await awaiting("uB1", AMC2);
  const mine = await call("custA", "GET", "/service-reports/mine");
  assert.equal(mine.status, 200);
  assert.ok(mine.body.reports.length >= 1);
  assert.ok(mine.body.reports.every((r: any) => r.customerId === "cA" && r.status !== "draft"));
  assert.ok(mine.body.reports.some((r: any) => r.id === a1.id));
  assert.equal((await call("mgmt", "GET", "/service-reports/mine")).status, 403);
  assert.equal((await call(null, "GET", "/service-reports/mine")).status, 401);
});

// =============================================================================================
// Failures and concurrency
// =============================================================================================

test("failed PDF generation: signing answers 500, stores nothing, leaves the report awaiting signature, and can be retried", async () => {
  reset();
  const r = await awaiting();
  const spy = mock.method(PDFDocument.prototype, "image", () => { throw new Error("boom"); });
  const failedSign = await sign("custA", r);
  spy.mock.restore();
  assert.deepEqual([failedSign.status, failedSign.body.code], [500, "PDF_GENERATION_FAILED"]);
  assert.equal(rowOf(r.id).status, "awaiting_signature");
  assert.equal(files.size, 0);
  assert.equal((await sign("custA", r)).status, 200);
});

test("failed storage: no half-signed report and no orphan file - on either write; storage not configured is a 503", async () => {
  for (const failAt of [1, 2]) {
    reset();
    const r = await awaiting();
    storageFlags.failPutNumber = failAt;
    const res = await sign("custA", r);
    assert.deepEqual([res.status, res.body.code], [502, "STORAGE_FAILED"], `put #${failAt}`);
    assert.deepEqual([rowOf(r.id).status, rowOf(r.id).pdfFileId, rowOf(r.id).signedAt], ["awaiting_signature", null, null]);
    assert.equal(files.size, 0);
  }
  reset();
  const r2 = await awaiting();
  setReportStorageForTests(null);
  assert.equal((await sign("custA", r2)).body.code, "STORAGE_NOT_CONFIGURED");
  assert.equal(rowOf(r2.id).status, "awaiting_signature");
});

test("failed database update at the last step: the stored files are removed again and the error is not hidden", async () => {
  reset();
  const r = await awaiting();
  dbFlags.failUpdateMany = true;
  assert.equal((await sign("custA", r)).status, 500);
  assert.equal(files.size, 0);
});

test("simultaneous signing: exactly one signature wins and no surplus files remain", async () => {
  reset();
  const r = await awaiting();
  const results = await Promise.all(Array.from({ length: 5 }, () => sign("custA", r)));
  assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
  assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 409));
  assert.equal(files.size, 2);
  assert.equal(reportEvents.filter((e) => e.type === "service_report_signed").length, 1);
});

test("simultaneous submission: exactly one wins and nothing is stored (the customer has not signed yet)", async () => {
  reset();
  const c = await createAmc("mgmt", AMC1, "uA1");
  const results = await Promise.all(Array.from({ length: 4 }, () => submit("mgmt", c.body)));
  assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
  assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 409));
  assert.equal(files.size, 0);
  assert.equal(rowOf(c.body.id).status, "awaiting_signature");
});

test("simultaneous creation for one AMC unit: one draft wins, the others get a clear 409", async () => {
  reset();
  const results = await Promise.all(Array.from({ length: 5 }, () => createAmc()));
  assert.equal(results.filter((x) => x.status === 201).length, 1, results.map((x) => x.status).join());
  assert.ok(results.filter((x) => x.status !== 201).every((x) => x.status === 409));
  assert.equal(rows.length, 1);
});

// =============================================================================================
// Requirement 4 stays intact
// =============================================================================================

test("ticket reports keep their ORIGINAL content fingerprint, so a ticket report submitted before AMC support still signs", async () => {
  const { reportContentHash } = await import("../src/routes/serviceReports");
  const r = {
    reportNumber: "TCK-1-R1", complaintId: "t1", customerId: "cA", siteId: "sA", unitId: "uA", visitDate: new Date("2026-10-14T00:00:00Z"),
    workPerformed: "w", findings: "f", resolution: "r", partsUsed: null, remarks: null, version: 3,
  };
  const legacy = createHash("sha256").update(JSON.stringify(["TCK-1-R1", "t1", "cA", "sA", "uA", "2026-10-14", "w", "f", "r", "", "", 3])).digest("hex");
  assert.equal(reportContentHash({ ...r, kind: "ticket", acknowledgementRequired: true, amcOrderId: null, unitSerialNo: null }), legacy);
  assert.equal(reportContentHash(r as any), legacy);
  assert.notEqual(reportContentHash({ ...r, kind: "amc", amcOrderId: "amc1", unitSerialNo: "SN", acknowledgementRequired: true } as any), legacy);
  assert.notEqual(
    reportContentHash({ ...r, kind: "amc", amcOrderId: "a", unitSerialNo: "SN", acknowledgementRequired: true } as any),
    reportContentHash({ ...r, kind: "amc", amcOrderId: "a", unitSerialNo: "SN", acknowledgementRequired: false } as any),
    "the acknowledgement rule is part of what is approved",
  );
});

test("DIRECT reports have their own content fingerprint; the ticket and AMC formulas are exactly as before", async () => {
  const { reportContentHash } = await import("../src/routes/serviceReports");
  const r = {
    reportNumber: "DSR-1-R1", complaintId: null, customerId: "cA", siteId: "sA", unitId: "uA", visitDate: new Date("2026-10-14T00:00:00Z"),
    workPerformed: "w", findings: "f", resolution: "r", partsUsed: null, remarks: null, version: 1, amcOrderId: null, unitSerialNo: null, acknowledgementRequired: true,
  };
  const direct = reportContentHash({ ...r, kind: "direct" });
  assert.match(direct, /^[0-9a-f]{64}$/);
  assert.equal(direct, createHash("sha256").update(JSON.stringify(["DSR-1-R1", null, "cA", "sA", "uA", "2026-10-14", "w", "f", "r", "", "", 1, "direct", ""])).digest("hex"));
  assert.notEqual(direct, reportContentHash({ ...r, kind: "ticket" }));
  assert.notEqual(direct, reportContentHash({ ...r, kind: "direct", unitSerialNo: "SN-9" }), "the serial snapshot is bound");
  // unchanged: the ticket formula and the AMC formula
  assert.equal(reportContentHash({ ...r, kind: "ticket" }), createHash("sha256").update(JSON.stringify(["DSR-1-R1", null, "cA", "sA", "uA", "2026-10-14", "w", "f", "r", "", "", 1])).digest("hex"));
  assert.equal(reportContentHash({ ...r, kind: "amc", amcOrderId: "a1", unitSerialNo: "SN" }), createHash("sha256").update(JSON.stringify(["DSR-1-R1", null, "cA", "sA", "uA", "2026-10-14", "w", "f", "r", "", "", 1, "amc", "a1", "SN", true])).digest("hex"));
});
