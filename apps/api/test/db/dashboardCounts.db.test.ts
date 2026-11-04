/**
 * Real-database test: the dashboard's site counts are now computed by the database (groupBy) - they must equal what the previous
 * in-memory count over every site produced, company-wide and for a single region.
 *
 * SAFETY: refuses to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database (localhost:5434/platino_test).
 * It only READS site data and creates / removes one user of its own.
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
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
const skip = isolated ? false : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("dashboard site counts by phase match the previous in-memory count", { skip }, () => {
  const PREFIX = `ZC${Date.now().toString(36).toUpperCase()}`;
  let prisma: any;
  let server: Server;
  let base = "";
  let token = "";
  let userId = "";

  before(async () => {
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database");
    const { signToken } = await import("../../src/lib/jwt");
    const { dashboardRouter } = await import("../../src/routes/dashboard");
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    const u = await prisma.user.create({ data: { name: `${PREFIX} admin`, roleId: role.id, isActive: true, mustChangePassword: false } });
    userId = u.id;
    token = signToken({ userId, roleKey: "super_admin", customerId: null, tokenVersion: u.tokenVersion });
    const app = express();
    app.use("/dashboard", dashboardRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
    if (server) await new Promise((r) => server.close(r));
  });

  const legacy = async (regionId?: string) => {
    const sites = await prisma.site.findMany({ where: regionId ? { regionId } : {}, include: { currentStage: true } });
    const out: Record<string, number> = { SUPPLY: 0, INSTALLATION: 0, TESTING: 0, COMMISSIONING: 0 };
    for (const s of sites) out[s.currentStage.phase] += 1;
    return out;
  };
  const get = async (query = "") => (await (await fetch(`${base}/dashboard${query}`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

  test("company-wide counts equal the old per-site count", async () => {
    const expected = await legacy();
    const body = await get();
    assert.deepEqual(body.sitesByPhase, expected);
    assert.equal(Object.values<number>(body.sitesByPhase).reduce((a, b) => a + b, 0), await prisma.site.count());
  });

  test("a single region's counts equal the old per-site count, and an unknown region is all zeros", async () => {
    const region = await prisma.site.findFirst({ where: { regionId: { not: null } }, select: { regionId: true } });
    if (region?.regionId) assert.deepEqual((await get(`?regionId=${region.regionId}`)).sitesByPhase, await legacy(region.regionId));
    const none = await get("?regionId=no-such-region");
    assert.deepEqual(none.sitesByPhase, { SUPPLY: 0, INSTALLATION: 0, TESTING: 0, COMMISSIONING: 0 });
  });
});
