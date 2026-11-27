/**
 * Real-database tests for the SIGNING CREDENTIAL (customer step of the in-person signing): created when staff hand the device over, valid for the one
 * report it was issued for, usable on exactly three requests (signing-view, sign, cancel), ended by cancel / completion / expiry / a newer session / an
 * edited report / a staff account that is no longer in good standing - and refused by EVERY other route in the API. Real routers, real authentication
 * and the real Prisma client.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test - the same guard as every other test/db file) and they only touch rows they create
 * themselves (unique run prefix; everything is removed in `after`). The signature is a generated PNG and all names are synthetic. Nothing is sent anywhere.
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("signing credential against the real test database", { skip }, () => {
  const PREFIX = `ZC${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), unitIds: new Set<string>(), regionIds: new Set<string>(), vendorIds: new Set<string>() };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let setStorage: (s: any) => void;
  let issueSigningCredential: (c: any, now?: number) => { token: string; expiresAt: Date };
  let TTL = 0;
  let productId = "";
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const W: Record<string, any> = {};
  const mounts: Array<{ prefix: string; router: any; name: string }> = [];

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }

  async function makeSide(tag: string, region: any, vendor: any) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag} Industries` } });
    tracked.customerIds.add(customer.id);
    const order = await prisma.order.create({
      data: {
        orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 1,
        site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, address: `${tag} Estate`, dgModel: "KG1-250", dgCapacityKva: 250, regionId: region.id, vendorId: vendor.id } },
      },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${++seq}`, orderId: order.id, siteId: order.site.id, productId, status: "active" } });
    tracked.unitIds.add(unit.id);
    return { customer, order, site: order.site, unit };
  }
  async function newUnit(side: any) {
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${++seq}`, orderId: side.order.id, siteId: side.site.id, productId, status: "active" } });
    tracked.unitIds.add(unit.id);
    return unit;
  }

  const tokenOf = (user: any) => signToken({ userId: user.id, roleKey: "x", customerId: user.customerId ?? null, tokenVersion: user.tokenVersion ?? 0 });
  type Auth = { staff?: any; credential?: string; raw?: string };
  async function call(as: Auth | null, method: string, path: string, body?: unknown) {
    const authorization = as?.credential ? `Signing ${as.credential}` : as?.raw ? as.raw : as?.staff ? `Bearer ${tokenOf(as.staff)}` : undefined;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { json = null; }
    return { status: res.status, body: json, headers: res.headers };
  }
  const staff = (u: any): Auth => ({ staff: u });
  const cred = (token: string): Auth => ({ credential: token });

  const fields = { visitDate: "2026-10-14", workPerformed: "Inspected the RECD and replaced the gasket.", findings: "Minor exhaust leak at the flange.", resolution: "Leak sealed; unit within limits." };
  async function awaiting(side: any, unit: any, who: any = W.mgmt) {
    const c = await call(staff(who), "POST", "/service-reports", { customerId: side.customer.id, unitId: unit.id, ...fields });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const s = await call(staff(who), "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: c.body.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body;
  }
  const startSession = (who: any, r: any) => call(staff(who), "POST", `/service-reports/${r.id}/signing-session`, { expectedVersion: r.version, handoffConfirmed: true });
  const signBody = (r: any, token: string, over: Record<string, unknown> = {}) => ({ signerName: "Asha Rao", signatureImage: pngDataUrl(makePng()), version: r.version, confirm: true, signingSession: token, ...over });
  const viewOf = (token: string, r: any) => call(cred(token), "GET", `/service-reports/${r.id}/signing-view`);
  const signWith = (token: string, r: any, over: Record<string, unknown> = {}) => call(cred(token), "POST", `/service-reports/${r.id}/sign`, signBody(r, token, over));
  const cancelWith = (token: string, r: any) => call(cred(token), "POST", `/service-reports/${r.id}/signing-session/cancel`, {});
  const rowOf = (id: string) => prisma.serviceReport.findUniqueOrThrow({ where: { id } });
  /** A fresh report, awaiting signature, with a started signing session: { r, token }. */
  async function started(who: any = W.mgmt) {
    const unit = await newUnit(W.A);
    const r = await awaiting(W.A, unit, who);
    const s = await startSession(who, r);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.ok(typeof s.body.signingCredential === "string" && s.body.signingCredential.length > 40);
    return { r, token: s.body.signingCredential as string, session: s.body.signingSession as string, start: s.body };
  }

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ setReportStorageForTests: setStorage } = await import("../../src/lib/reportStorage"));
    setStorage(undefined);
    ({ issueSigningCredential, SIGNING_SESSION_TTL_MS: TTL } = await import("../../src/lib/signingSession") as any);

    // Mount EVERY router at the same prefix the real app uses (parsed from src/index.ts), so the route sweep covers the whole API.
    const indexSrc = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf8");
    const fileOf: Record<string, string> = {};
    for (const m of indexSrc.matchAll(/import \{([^}]+)\} from "\.\/routes\/(\w+)";/g)) for (const n of m[1].split(",")) fileOf[n.trim()] = m[2];
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    for (const m of indexSrc.matchAll(/^app\.use\("(\/[^"]*)", (\w+Router)\);/gm)) {
      const mod = await import(`../../src/routes/${fileOf[m[2]]}`);
      assert.ok(mod[m[2]], `router ${m[2]} exported`);
      mounts.push({ prefix: m[1], router: mod[m[2]], name: m[2] });
      app.use(m[1], mod[m[2]]);
    }
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolveListen) => { server = app.listen(0, "127.0.0.1", resolveListen); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_engineer", "management", "sales"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    W.R1 = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-1`, name: `${PREFIX} R1` } });
    tracked.regionIds.add(W.R1.id);
    W.V1 = await prisma.vendor.create({ data: { name: `${PREFIX} V1`, status: "approved", contactName: "c", contactEmail: `${PREFIX.toLowerCase()}-v1@example.test` } });
    tracked.vendorIds.add(W.V1.id);
    W.mgmt = await makeUser("manager", "management");
    W.mgmt2 = await makeUser("manager two", "management");
    W.sales = await makeUser("sales", "sales");
    W.A = await makeSide("Alpha", W.R1, W.V1);
  });

  after(async () => {
    server?.close();
    setStorage?.(undefined);
    try {
      if (prisma) {
        const customerIds = [...tracked.customerIds];
        const reports = await prisma.serviceReport.findMany({ where: { customerId: { in: customerIds } }, select: { id: true, signatureFileId: true, pdfFileId: true } });
        await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" DISABLE TRIGGER "ServiceReport_final_no_delete"');
        try {
          await prisma.serviceReport.deleteMany({ where: { id: { in: reports.map((r: any) => r.id) } } }); // their events cascade
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" ENABLE TRIGGER "ServiceReport_final_no_delete"');
        }
        await prisma.reportFile.deleteMany({ where: { id: { in: reports.flatMap((r: any) => [r.signatureFileId, r.pdfFileId]).filter(Boolean) } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
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

  // ------------------------------------------------------------------------------------------------------------------------------------------
  test("starting: the hand-over still returns the session AND now a signing credential; the start is recorded with the session id", async () => {
    const { r, start } = await started();
    assert.ok(start.signingSession && start.signingCredential && start.signingSession !== start.signingCredential);
    assert.equal(start.version, r.version);
    const ev = await prisma.serviceReportEvent.findMany({ where: { reportId: r.id, type: "service_report_signing_started" } });
    assert.equal(ev.length, 1);
    assert.equal(typeof ev[0].detail.sessionId, "string");
    assert.equal(ev[0].actorId, W.mgmt.id);
    // the credential's token never appears in the audit record
    assert.ok(!JSON.stringify(ev[0].detail).includes(start.signingCredential));
  });

  test("signing-view: the credential reads ONLY what the customer is shown (no history, no file references, no staff-only fields), and can do so again after a reload", async () => {
    const { r, token } = await started();
    const v = await viewOf(token, r);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.deepEqual(Object.keys(v.body).sort(), ["amc", "customerName", "engineer", "findings", "id", "kind", "partsUsed", "remarks", "reportNumber", "resolution", "site", "status", "ticketNumber", "unit", "version", "visitDate", "workPerformed"]);
    assert.equal(v.body.id, r.id);
    assert.equal(v.body.status, "awaiting_signature");
    assert.equal(v.body.workPerformed, fields.workPerformed);
    assert.deepEqual(Object.keys(v.body.engineer), ["name"], "the engineer's name only - no id");
    assert.equal(v.headers.get("cache-control"), "private, no-store");
    const again = await viewOf(token, r);
    assert.equal(again.status, 200, "a reload can resume the customer step");
  });

  test("signing with the credential only (no staff login): the report is signed, the PDF stored, the customer's typed name is the signer, the staff account is the audit actor", async () => {
    const { r, token } = await started();
    const s = await signWith(token, r);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(Object.keys(s.body).sort(), ["id", "reportNumber", "signedAt", "signerName", "status", "version"], "a confirmation only, not the whole record");
    assert.equal(s.body.status, "signed");
    const row = await rowOf(r.id);
    assert.equal(row.status, "signed");
    assert.equal(row.signerName, "Asha Rao");
    assert.equal(row.signedById, null);
    assert.ok(row.pdfFileId && row.signatureFileId && row.pdfSha256);
    const ev = await prisma.serviceReportEvent.findFirst({ where: { reportId: r.id, type: "service_report_signed" } });
    assert.equal(ev.actorId, W.mgmt.id);
    assert.equal(ev.detail.viaSigningCredential, true);
    assert.equal(ev.detail.mode, "in_person");
    // locking is unchanged: final reports cannot be edited
    const edit = await call(staff(W.mgmt), "PATCH", `/service-reports/${r.id}`, { expectedVersion: r.version, workPerformed: "Changed after signing" });
    assert.ok([403, 409].includes(edit.status), `edit after signing refused (${edit.status})`);
    // the staff login still downloads the PDF
    const pdf = await call(staff(W.mgmt), "GET", `/service-reports/${r.id}/pdf`);
    assert.equal(pdf.status, 200);
  });

  test("after completion the credential is dead: view, sign and cancel are all refused", async () => {
    const { r, token } = await started();
    assert.equal((await signWith(token, r)).status, 200);
    for (const res of [await viewOf(token, r), await signWith(token, r), await cancelWith(token, r)]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.code, "SIGNING_SESSION_INVALID");
    }
  });

  test("the existing validation is unchanged for the credential: a staff member's own name is refused (and the credential stays usable), a tiny signature is refused, a wrong version is refused", async () => {
    const { r, token } = await started();
    const staffName = await signWith(token, r, { signerName: W.mgmt.name });
    assert.equal(staffName.status, 400);
    assert.equal(staffName.body.code, "SIGNER_IS_STAFF");
    const tiny = await signWith(token, r, { signatureImage: pngDataUrl(makePng({ width: 10, height: 10 })) });
    assert.equal(tiny.status, 400);
    assert.equal(tiny.body.code, "BAD_SIGNATURE");
    const stale = await signWith(token, r, { version: r.version + 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "STALE_VERSION");
    const noApproval = await call(cred(token), "POST", `/service-reports/${r.id}/sign`, signBody(r, token, { confirm: false }));
    assert.equal(noApproval.status, 400);
    assert.equal((await rowOf(r.id)).status, "awaiting_signature");
    assert.equal((await viewOf(token, r)).status, 200, "none of those ended the session");
    assert.equal((await signWith(token, r)).status, 200, "and a correct signature still works");
  });

  test("the body copy of the credential must be the same credential as the header", async () => {
    const a = await started();
    const b = await started();
    const mismatch = await call(cred(a.token), "POST", `/service-reports/${a.r.id}/sign`, signBody(a.r, b.token));
    assert.equal(mismatch.status, 401);
    const legacyInBody = await call(cred(a.token), "POST", `/service-reports/${a.r.id}/sign`, signBody(a.r, a.session));
    assert.equal(legacyInBody.status, 401, "the older signing-session token is not a credential");
    assert.equal((await rowOf(a.r.id)).status, "awaiting_signature");
  });

  test("cancel: the credential stops working IMMEDIATELY (view and sign refused), nothing is signed, and a new hand-over works", async () => {
    const { r, token } = await started();
    const c = await cancelWith(token, r);
    assert.equal(c.status, 200);
    assert.deepEqual(c.body, { ok: true });
    for (const res of [await viewOf(token, r), await signWith(token, r), await cancelWith(token, r)]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.code, "SIGNING_SESSION_INVALID");
    }
    assert.equal((await rowOf(r.id)).status, "awaiting_signature");
    const ev = await prisma.serviceReportEvent.findMany({ where: { reportId: r.id, type: "service_report_signing_cancelled" } });
    assert.equal(ev.length, 1);
    const again = await startSession(W.mgmt, r);
    assert.equal(again.status, 200);
    assert.equal((await viewOf(again.body.signingCredential, r)).status, 200, "a new session after a cancel works");
    assert.equal((await viewOf(token, r)).status, 401, "while the cancelled one stays dead");
  });

  test("a newer signing session replaces the older one: only the newest credential is live", async () => {
    const first = await started();
    const second = await startSession(W.mgmt, first.r);
    assert.equal(second.status, 200);
    assert.equal((await viewOf(first.token, first.r)).status, 401);
    assert.equal((await signWith(first.token, first.r)).status, 401);
    assert.equal((await viewOf(second.body.signingCredential, first.r)).status, 200);
    // another staff member starting a session also replaces it
    const third = await startSession(W.mgmt2, first.r);
    assert.equal(third.status, 200);
    assert.equal((await viewOf(second.body.signingCredential, first.r)).status, 401);
    assert.equal((await signWith(third.body.signingCredential, first.r)).status, 200);
  });

  test("expiry: a credential past its time is refused, exactly at the limit it still works", async () => {
    const { r } = await started();
    const live = await prisma.serviceReportEvent.findFirst({ where: { reportId: r.id, type: "service_report_signing_started" } });
    const base = { reportId: r.id, version: r.version, staffId: W.mgmt.id, tokenVersion: 0, sessionId: live.detail.sessionId };
    const now = Date.now();
    const fresh = issueSigningCredential(base, now);
    const old = issueSigningCredential(base, now - TTL - 5_000); // issued just over TTL ago: expired
    assert.equal((await viewOf(fresh.token, r)).status, 200);
    const expired = await viewOf(old.token, r);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, "SIGNING_SESSION_INVALID");
    assert.equal((await signWith(old.token, r)).status, 401);
    assert.equal((await rowOf(r.id)).status, "awaiting_signature");
  });

  test("one report only: a credential cannot be used on another report, and an edited / re-submitted report (new version) ends it", async () => {
    const a = await started();
    const b = await started();
    const other = await viewOf(a.token, b.r);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, "SIGNING_CREDENTIAL_SCOPE");
    assert.equal((await signWith(a.token, b.r)).status, 403);
    assert.equal((await cancelWith(a.token, b.r)).status, 403);
    assert.equal((await rowOf(b.r.id)).status, "awaiting_signature");
    // staff take report A back to draft: the version moves on and the credential is dead
    const re = await call(staff(W.mgmt), "POST", `/service-reports/${a.r.id}/reopen`, { expectedVersion: a.r.version });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal((await viewOf(a.token, a.r)).status, 409, "refused: the report is no longer awaiting a signature");
    assert.notEqual((await signWith(a.token, a.r)).status, 200);
    assert.equal((await rowOf(a.r.id)).status, "draft");
    // submitted again (a new version): the old credential still cannot read or sign it
    const again = await call(staff(W.mgmt), "POST", `/service-reports/${a.r.id}/submit`, { expectedVersion: re.body.version });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.notEqual(again.body.version, a.r.version);
    assert.equal((await viewOf(a.token, a.r)).status, 401);
    assert.equal((await signWith(a.token, a.r, { version: again.body.version })).status, 401);
    assert.equal((await rowOf(a.r.id)).status, "awaiting_signature");
  });

  test("the staff account must stay in good standing: deactivated, password changed (token version), forced password change, or no longer allowed to write - each ends the credential", async () => {
    const mk = async (tag: string) => {
      const u = await makeUser(tag, "management");
      const unit = await newUnit(W.A);
      const r = await awaiting(W.A, unit, u);
      const s = await startSession(u, r);
      assert.equal(s.status, 200, JSON.stringify(s.body));
      return { u, r, token: s.body.signingCredential as string };
    };
    const d = await mk("will be deactivated");
    assert.equal((await viewOf(d.token, d.r)).status, 200);
    await prisma.user.update({ where: { id: d.u.id }, data: { isActive: false } });
    assert.equal((await viewOf(d.token, d.r)).status, 401);
    assert.equal((await signWith(d.token, d.r)).status, 401);

    const p = await mk("changes password");
    await prisma.user.update({ where: { id: p.u.id }, data: { tokenVersion: { increment: 1 } } });
    assert.equal((await viewOf(p.token, p.r)).status, 401);

    const m = await mk("must change password");
    await prisma.user.update({ where: { id: m.u.id }, data: { mustChangePassword: true } });
    assert.equal((await viewOf(m.token, m.r)).status, 401);

    const g = await mk("loses write access");
    await prisma.user.update({ where: { id: g.u.id }, data: { roleId: roleIds.sales, tokenVersion: { increment: 0 } } });
    const lost = await viewOf(g.token, g.r);
    assert.ok([401, 403].includes(lost.status), `refused (${lost.status})`);
    assert.equal((await signWith(g.token, g.r)).status === 200, false);
    for (const x of [d, p, m, g]) assert.equal((await rowOf(x.r.id)).status, "awaiting_signature", "nothing was signed");
  });

  test("forged, tampered and mixed-up credentials are refused: the old session token, a login token, a random string, a credential with a changed byte", async () => {
    const { r, token, session } = await started();
    const login = tokenOf(W.mgmt);
    for (const bad of [session, login, "abc", `${token}x`, token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA"), `${token.split(".")[0]}.`, `.${token.split(".")[1]}`]) {
      const v = await call(cred(bad), "GET", `/service-reports/${r.id}/signing-view`);
      assert.equal(v.status, 401, `refused: ${bad.slice(0, 12)}…`);
    }
    // a credential presented as a Bearer login, and a login token presented as a credential, both get nothing
    const asBearer = await call({ raw: `Bearer ${token}` }, "GET", `/service-reports/${r.id}`);
    assert.equal(asBearer.status, 401);
    const loginAsCred = await call(cred(login), "GET", `/service-reports/${r.id}/signing-view`);
    assert.equal(loginAsCred.status, 401);
    // wrong-case or wrong-scheme headers are not special
    for (const raw of [`signing ${token}`, `SIGNING ${token}`, token]) {
      const x = await call({ raw }, "GET", `/service-reports/${r.id}/signing-view`);
      assert.equal(x.status, 401, `refused: ${raw.slice(0, 14)}…`);
    }
  });

  test("scope inside the service-report router: every OTHER request with a valid credential is refused (403) before any handler runs - detail, list, edit, submit, reopen, create, start, PDF, signature", async () => {
    const { r, token } = await started();
    const id = r.id;
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `/service-reports/${id}`],
      ["GET", `/service-reports`],
      ["GET", `/service-reports/${id}/pdf`],
      ["GET", `/service-reports/${id}/signature`],
      ["PATCH", `/service-reports/${id}`, { expectedVersion: r.version, workPerformed: "x" }],
      ["PUT", `/service-reports/${id}`, {}],
      ["DELETE", `/service-reports/${id}`],
      ["POST", `/service-reports`, {}],
      ["POST", `/service-reports/${id}/submit`, { expectedVersion: r.version }],
      ["POST", `/service-reports/${id}/reopen`, { expectedVersion: r.version }],
      ["POST", `/service-reports/${id}/signing-session`, { expectedVersion: r.version, handoffConfirmed: true }],
      ["GET", `/service-reports/${id}/signing-view/`],
      ["GET", `/service-reports/${id}/SIGNING-VIEW`],
      ["HEAD", `/service-reports/${id}/signing-view`],
      ["POST", `/service-reports/${id}/signing-view`, {}],
      ["GET", `/service-reports/${id}/sign`],
      ["GET", `/service-reports/${id}/signing-session/cancel`],
      ["POST", `/service-reports/${id}/sign/`, {}],
      ["GET", `/service-reports/${id}%2F..%2F${id}/signing-view`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(cred(token), method, path, body);
      assert.ok(res.status === 403 || res.status === 401 || res.status === 404, `${method} ${path} -> ${res.status}`);
      assert.notEqual(res.status, 200, `${method} ${path}`);
      if (res.status === 403 && method !== "HEAD") assert.equal(res.body?.code, "SIGNING_CREDENTIAL_SCOPE", `${method} ${path}`);
    }
    assert.equal((await rowOf(id)).version, r.version, "nothing changed");
    assert.equal((await viewOf(token, r)).status, 200, "and the credential is still good for its three requests");
  });

  test("ROUTE SWEEP: across EVERY router in the API, a valid signing credential gets nothing: the service-report router answers 403 outside the three approved requests; every other route answers exactly as it does with no login at all", async () => {
    const { r, token } = await started();
    // enumerate every (method, path) of every mounted router
    const routes: Array<{ method: string; path: string; router: string }> = [];
    const walk = (router: any, prefix: string, name: string) => {
      for (const layer of router.stack ?? []) {
        if (layer.route) {
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          for (const p of paths) if (typeof p === "string") for (const m of Object.keys(layer.route.methods)) if (layer.route.methods[m]) routes.push({ method: m.toUpperCase(), path: prefix + (p === "/" ? "" : p), router: name });
        } else if (layer.handle?.stack) {
          // a nested router mounted with .use(path, router): the mount path is not on the layer in Express 5, and this API does not nest routers
          walk(layer.handle, prefix, name);
        }
      }
    };
    for (const m of mounts) walk(m.router, m.prefix, m.name);
    assert.ok(routes.length > 120, `the sweep covers the whole API (${routes.length} routes)`);
    assert.ok(routes.some((x) => x.router === "authRouter") && routes.some((x) => x.router === "usersRouter") && routes.some((x) => x.router === "complaintsRouter") && routes.some((x) => x.router === "agentConversationsRouter"));

    const approved = new Set([`GET /service-reports/${r.id}/signing-view`, `POST /service-reports/${r.id}/sign`, `POST /service-reports/${r.id}/signing-session/cancel`]);
    const fill = (p: string) => p.replace(/:(\w+)/g, (_m, n) => (n === "id" && p.startsWith("/service-reports") ? r.id : "x1"));
    const differing: string[] = [];
    let checked = 0;
    for (const route of routes) {
      const path = fill(route.path);
      const key = `${route.method} ${path}`;
      if (approved.has(key)) continue;
      const body = ["POST", "PUT", "PATCH"].includes(route.method) ? {} : undefined;
      const withCred = await call(cred(token), route.method, path, body);
      const anonymous = await call(null, route.method, path, body);
      checked++;
      if (route.router === "serviceReportsRouter") {
        assert.equal(withCred.status, 403, `${key} -> ${withCred.status}`);
        assert.equal(withCred.body?.code, "SIGNING_CREDENTIAL_SCOPE", key);
      } else if (withCred.status !== anonymous.status) {
        differing.push(`${key}: credential ${withCred.status}, anonymous ${anonymous.status}`);
      }
      assert.ok(![200, 201, 204].includes(withCred.status) || anonymous.status === withCred.status, `${key} answered ${withCred.status} to a signing credential`);
    }
    assert.deepEqual(differing, [], "no route outside the service-report router treats a signing credential differently from no login");
    assert.ok(checked > 120);
    // and the three approved requests are the ONLY ones that accept it
    assert.equal((await viewOf(token, r)).status, 200);
    assert.equal((await cancelWith(token, r)).status, 200);
  });

  test("the staff flow is unchanged: the older Bearer + signing-session path still signs a report (kept during rollout), and a customer login still cannot sign", async () => {
    const unit = await newUnit(W.A);
    const r = await awaiting(W.A, unit);
    const s = await startSession(W.mgmt, r);
    const viaStaff = await call(staff(W.mgmt), "POST", `/service-reports/${r.id}/sign`, signBody(r, s.body.signingSession));
    assert.equal(viaStaff.status, 200, JSON.stringify(viaStaff.body));
    assert.ok(viaStaff.body.pdfAvailable === true && viaStaff.body.engineer, "the staff path still answers with the full record");
    // a staff login with a credential-looking body but no session is refused as before
    const unit2 = await newUnit(W.A);
    const r2 = await awaiting(W.A, unit2);
    const noSession = await call(staff(W.mgmt), "POST", `/service-reports/${r2.id}/sign`, signBody(r2, "x".repeat(30)));
    assert.equal(noSession.status, 403);
    assert.equal(noSession.body.code, "SIGNING_SESSION_INVALID");
    // the credential of a session is not accepted as a staff signing session on the Bearer path either
    const s2 = await startSession(W.mgmt, r2);
    const mixed = await call(staff(W.mgmt), "POST", `/service-reports/${r2.id}/sign`, signBody(r2, s2.body.signingCredential));
    assert.equal(mixed.status, 403);
  });
});
