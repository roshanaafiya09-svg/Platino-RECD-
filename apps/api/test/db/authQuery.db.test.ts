/**
 * Real-database test for the authentication middleware after it moved to ONE joined query (relationLoadStrategy "join"): for every role in
 * the database the permissions, role key, customer / vendor link and the refusals (inactive, stale tokenVersion, forced password change,
 * unknown user) are exactly what the previous multi-query lookup produced.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; removed in `after`).
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
describe("authentication middleware (single SQL statement) against the real test database", { skip }, () => {
  const PREFIX = `ZA${Date.now().toString(36).toUpperCase()}`;
  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  const userIds: string[] = [];
  const realConsole = { log: console.log, error: console.error };

  const mk = async (roleKey: string, extra: Record<string, unknown> = {}) => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${roleKey}`, roleId: role.id, isActive: true, mustChangePassword: false, ...extra } });
    userIds.push(u.id);
    return u;
  };
  const call = async (path: string, u: any, tokenVersion = u.tokenVersion) => {
    const token = signToken({ userId: u.id, roleKey: "ignored", customerId: null, tokenVersion });
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database");
    ({ signToken } = await import("../../src/lib/jwt"));
    const { authenticate, authenticateAllowingPasswordChange, requirePermission } = await import("../../src/middleware/auth");
    const app = express();
    app.get("/who", authenticate, (req: any, res) => res.json({ ...req.auth, permissions: [...req.auth.permissions].sort() }));
    app.get("/who-pw", authenticateAllowingPasswordChange, (req: any, res) => res.json({ userId: req.auth.userId }));
    app.get("/needs-manage-users", authenticate, requirePermission("manage_users"), (_q, res) => res.json({ ok: true }));
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    console.log = realConsole.log;
    console.error = realConsole.error;
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
    if (server) await new Promise((r) => server.close(r));
  });

  test("every role gets exactly the permissions the previous nested-include lookup returned", async () => {
    const roles = await prisma.role.findMany({ select: { key: true } });
    assert.ok(roles.length >= 5);
    for (const { key } of roles) {
      const u = await mk(key);
      const old = await prisma.user.findUnique({ where: { id: u.id }, include: { role: { include: { permissions: { include: { permission: true } } } } } });
      const { status, body } = await call("/who", u);
      assert.equal(status, 200, key);
      assert.equal(body.roleKey, old.role.key);
      assert.equal(body.userId, u.id);
      assert.deepEqual(body.permissions, old.role.permissions.map((rp: any) => rp.permission.key).sort(), key);
    }
  });

  test("a role with no permissions at all authenticates with an empty permission set (the grouped query must not drop the user)", async () => {
    const role = await prisma.role.create({ data: { key: `${PREFIX.toLowerCase()}_empty`, name: `${PREFIX} no permissions` } });
    try {
      const u = await prisma.user.create({ data: { name: `${PREFIX} empty`, roleId: role.id, isActive: true, mustChangePassword: false } });
      userIds.push(u.id);
      const { status, body } = await call("/who", u);
      assert.equal(status, 200);
      assert.deepEqual(body.permissions, []);
      assert.equal(body.roleKey, role.key);
      assert.equal((await call("/needs-manage-users", u)).status, 403);
    } finally {
      await prisma.user.deleteMany({ where: { roleId: role.id } });
      await prisma.role.delete({ where: { id: role.id } });
    }
  });

  test("customer and vendor links are carried through", async () => {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} customer` } });
    try {
      const u = await mk("customer", { customerId: customer.id });
      const { body } = await call("/who", u);
      assert.equal(body.customerId, customer.id);
      assert.equal(body.vendorId, null);
    } finally {
      await prisma.user.deleteMany({ where: { customerId: customer.id } });
      await prisma.customer.delete({ where: { id: customer.id } });
    }
  });

  test("refusals are unchanged: unknown user, inactive account, stale tokenVersion, forced password change", async () => {
    const ghost = { id: "does-not-exist", tokenVersion: 0 };
    assert.equal((await call("/who", ghost)).status, 401);

    const inactive = await mk("super_admin", { isActive: false });
    assert.equal((await call("/who", inactive)).status, 401);

    const bumped = await mk("super_admin", { tokenVersion: 3 });
    assert.equal((await call("/who", bumped, 2)).status, 401);
    assert.equal((await call("/who", bumped, 3)).status, 200);

    const mustChange = await mk("super_admin", { mustChangePassword: true });
    const blocked = await call("/who", mustChange);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await call("/who-pw", mustChange)).status, 200);

    const none = await fetch(`${base}/who`);
    assert.equal(none.status, 401);
  });

  test("permission checks still apply on top of the loaded permissions", async () => {
    const admin = await mk("super_admin");
    const customerRole = await mk("customer");
    const allowed = (await call("/who", admin)).body.permissions.includes("manage_users");
    assert.equal((await call("/needs-manage-users", admin)).status, allowed ? 200 : 403);
    assert.equal((await call("/needs-manage-users", customerRole)).status, 403);
  });
});
