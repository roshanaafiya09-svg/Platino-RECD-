/**
 * Real-database test for the OPTIONAL paging on GET /customers and GET /sites: without ?limit= the answer is every row in the old order
 * (what the web and mobile apps rely on); with it, pages are consecutive, never overlap, together equal the full list, and
 * X-Total-Count carries the total. Unusable values fall back to the unpaged answer; the page size is capped.
 *
 * SAFETY: refuses to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database (localhost:5434/platino_test).
 * It only READS list data and creates / removes one user of its own.
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
const skip = isolated ? false : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";describe("optional paging on the customer and site lists", { skip }, () => {
  const PREFIX = `ZP${Date.now().toString(36).toUpperCase()}`;
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
    const { customersRouter } = await import("../../src/routes/customers");
    const { sitesRouter } = await import("../../src/routes/sites");
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    const u = await prisma.user.create({ data: { name: `${PREFIX} admin`, roleId: role.id, isActive: true, mustChangePassword: false } });
    userId = u.id;
    token = signToken({ userId, roleKey: "super_admin", customerId: null, tokenVersion: u.tokenVersion });
    const app = express();
    app.use("/customers", customersRouter);
    app.use("/sites", sitesRouter);
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

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, total: res.headers.get("x-total-count"), body: (await res.json()) as any[] };
  };

  for (const path of ["/customers", "/sites"]) {
    test(`${path}: no limit = every row, no total header; pages are consecutive, disjoint and add up to the same rows`, async () => {
      const all = await get(path);
      assert.equal(all.status, 200);
      assert.equal(all.total, null);
      const count = all.body.length;
      assert.ok(count > 25, "needs more than a page of rows to be meaningful");

      const seen: string[] = [];
      for (let offset = 0; offset < count; offset += 25) {
        const page = await get(`${path}?limit=25&offset=${offset}`);
        assert.equal(page.status, 200);
        assert.equal(page.total, String(count));
        assert.ok(page.body.length <= 25);
        seen.push(...page.body.map((r) => r.id));
      }
      assert.equal(seen.length, count);
      assert.equal(new Set(seen).size, count, "no row on two pages");
      assert.deepEqual([...seen].sort(), all.body.map((r) => r.id).sort(), "same set of rows");
    });

    test(`${path}: unusable limit / offset values give the unpaged answer or offset 0; the page size is capped`, async () => {
      const all = await get(path);
      for (const q of ["?limit=abc", "?limit=0", "?limit=-5", "?limit="]) {
        const r = await get(`${path}${q}`);
        assert.equal(r.total, null, q);
        assert.deepEqual(r.body.map((x) => x.id), all.body.map((x) => x.id), q);
      }
      const first = await get(`${path}?limit=5&offset=abc`);
      assert.deepEqual(first.body.map((x) => x.id), (await get(`${path}?limit=5`)).body.map((x) => x.id));
      const huge = await get(`${path}?limit=100000`);
      assert.ok(huge.body.length <= 500);
    });
  }
});
